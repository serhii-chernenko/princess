import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const githubApiOrigin = 'https://api.github.com';
const githubRequestTimeoutMilliseconds = 15_000;
const maximumSourceFileBytes = 5 * 1024 * 1024;
const maximumTotalSourceBytes = 15 * 1024 * 1024;
const maximumGithubMetadataBytes = 512 * 1024;
const maximumD1StatementBytes = 100_000;
const defaultGithubRepository = 'serhii-chernenko/princess-db';
const githubCliEnvironmentKeys = new Set([
    'APPDATA',
    'COMSPEC',
    'ComSpec',
    'GH_CONFIG_DIR',
    'GH_HOST',
    'HOME',
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'WINDIR',
    'XDG_CONFIG_HOME'
]);

const sourceFileNames = {
    channels: ['channels.json'],
    players: ['players.json'],
    scores: ['scores.json'],
    statuses: ['status.json', 'statuses.json']
} as const;

type SourceCollection = keyof typeof sourceFileNames;
type ExportFormat = 'json-array' | 'ndjson';

interface MongoChannelPlayerReference {
    playerId: string;
    scoreId: string;
    statusId: string;
}

interface MongoChannelRecord {
    mongoId: string;
    telegramChatId: number;
    updatedAt: number | null;
    releaseVersion: string;
    players: MongoChannelPlayerReference[];
}

interface MongoPlayerRecord {
    mongoId: string;
    telegramUserId: number;
    displayName: string;
}

interface MongoScoreRecord {
    mongoId: string;
    channelMongoId: string;
    playerMongoId: string;
    score: number;
}

interface MongoStatusRecord {
    mongoId: string;
    channelMongoId: string;
    playerMongoId: string;
    isActive: boolean;
    isAutoJoined: boolean;
}

interface PlayerRow {
    telegramUserId: number;
    displayName: string;
    createdAt: number;
    updatedAt: number;
}

interface ChannelRow {
    telegramChatId: number;
    language: string;
    releaseVersion: string;
    lastVoteAt: number | null;
    createdAt: number;
}

interface ChannelMemberRow {
    telegramChatId: number;
    telegramUserId: number;
    score: number;
    isActive: boolean;
    isAutoJoined: boolean;
    createdAt: number;
    updatedAt: number;
}

interface LoadedSourceFile {
    name: string;
    bytes: Uint8Array;
    sha256: string;
    blobSha: string | null;
    declaredByteLength: number;
}

type LoadedSourceFiles = Record<SourceCollection, LoadedSourceFile>;

interface SourceFileReport {
    name: string;
    format: ExportFormat;
    byteLength: number;
    declaredByteLength: number;
    sha256: string;
    blobSha: string | null;
    recordCount: number;
}

type SourceFilesReport = Record<SourceCollection, SourceFileReport>;

export type MongoImportSource =
    | {
          kind: 'directory';
          directory: string;
      }
    | {
          kind: 'github';
          repository?: string;
          ref: string;
          requireCommitSha?: boolean;
      };

type ImportSourceReport =
    | {
          kind: 'directory';
          directory: string;
          files: SourceFilesReport;
      }
    | {
          kind: 'github';
          repository: string;
          requestedRef: string;
          resolvedCommitSha: string;
          files: SourceFilesReport;
      };

export interface ImportReport {
    source: ImportSourceReport;
    outputSqlPath: string;
    outputReportPath: string;
    sourceCounts: Record<SourceCollection, number>;
    transformedCounts: {
        channels: number;
        players: number;
        channelMembers: number;
    };
    validation: {
        validated: true;
        duplicates: 0;
        unresolvedReferences: 0;
        ownershipMismatches: 0;
        skippedRecords: 0;
    };
}

export interface PrepareMongoImportOptions {
    source: MongoImportSource;
    outputDirectory?: string;
    importTimestamp?: number;
    fetchImplementation?: typeof fetch;
    githubToken?: string;
}

interface ParsedSourceFile<T> {
    records: T[];
    report: SourceFileReport;
}

interface ParsedCollections {
    channels: ParsedSourceFile<MongoChannelRecord>;
    players: ParsedSourceFile<MongoPlayerRecord>;
    scores: ParsedSourceFile<MongoScoreRecord>;
    statuses: ParsedSourceFile<MongoStatusRecord>;
}

const playerChunkSize = 20;
const channelChunkSize = 20;
const channelMemberChunkSize = 10;

const failValidation = (location: string, message: string): never => {
    throw new Error(`Invalid Mongo export at ${location}: ${message}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const readRecord = (
    value: unknown,
    location: string
): Record<string, unknown> => {
    if (!isRecord(value)) {
        return failValidation(location, 'expected an object');
    }

    return value;
};

const readNonEmptyString = (
    value: unknown,
    location: string,
    maximumLength: number
): string => {
    if (
        typeof value !== 'string' ||
        value.trim().length === 0 ||
        value.length > maximumLength
    ) {
        return failValidation(location, 'expected a non-empty string');
    }

    return value;
};

const readSafeInteger = (
    value: unknown,
    location: string,
    minimum?: number
): number => {
    if (!Number.isSafeInteger(value)) {
        return failValidation(location, 'expected a safe integer');
    }

    const integerValue = value as number;

    if (minimum !== undefined && integerValue < minimum) {
        return failValidation(
            location,
            `expected an integer greater than or equal to ${minimum}`
        );
    }

    return integerValue;
};

const readBoolean = (value: unknown, location: string): boolean => {
    if (typeof value !== 'boolean') {
        return failValidation(location, 'expected a boolean');
    }

    return value;
};

const readMongoOid = (value: unknown, location: string): string => {
    const oidRecord = readRecord(value, location);
    const oid = oidRecord.$oid;

    if (typeof oid !== 'string' || !/^[0-9a-f]{24}$/i.test(oid)) {
        return failValidation(location, 'expected an Extended JSON ObjectId');
    }

    return oid.toLowerCase();
};

const readMongoDate = (value: unknown, location: string): number => {
    const dateRecord = readRecord(value, location);
    const extendedDate = dateRecord.$date;
    let timestamp: number;

    if (typeof extendedDate === 'string') {
        timestamp = Date.parse(extendedDate);
    } else {
        const canonicalDate = readRecord(extendedDate, `${location}.$date`);
        const numberLong = canonicalDate.$numberLong;

        if (typeof numberLong !== 'string' || !/^-?\d+$/.test(numberLong)) {
            return failValidation(
                location,
                'expected an Extended JSON date string or $numberLong'
            );
        }

        timestamp = Number(numberLong);
    }

    if (
        !Number.isSafeInteger(timestamp) ||
        Number.isNaN(new Date(timestamp).getTime())
    ) {
        return failValidation(location, 'expected a valid millisecond date');
    }

    return timestamp;
};

const validateChannelRecord = (
    value: unknown,
    location: string
): MongoChannelRecord => {
    const record = readRecord(value, location);
    const telegramChatId = readSafeInteger(
        record.entity_id,
        `${location}.entity_id`
    );

    if (telegramChatId === 0) {
        return failValidation(
            `${location}.entity_id`,
            'Telegram ID cannot be zero'
        );
    }

    if (!Array.isArray(record.players)) {
        return failValidation(`${location}.players`, 'expected an array');
    }

    const players = record.players.map((playerReference, index) => {
        const playerLocation = `${location}.players[${index}]`;
        const playerRecord = readRecord(playerReference, playerLocation);

        return {
            playerId: readMongoOid(
                playerRecord.player_id,
                `${playerLocation}.player_id`
            ),
            scoreId: readMongoOid(
                playerRecord.score_id,
                `${playerLocation}.score_id`
            ),
            statusId: readMongoOid(
                playerRecord.status_id,
                `${playerLocation}.status_id`
            )
        };
    });

    return {
        mongoId: readMongoOid(record._id, `${location}._id`),
        telegramChatId,
        updatedAt:
            record.updated_at === null
                ? null
                : readMongoDate(record.updated_at, `${location}.updated_at`),
        releaseVersion: readNonEmptyString(
            record.release,
            `${location}.release`,
            128
        ),
        players
    };
};

const validatePlayerRecord = (
    value: unknown,
    location: string
): MongoPlayerRecord => {
    const record = readRecord(value, location);

    return {
        mongoId: readMongoOid(record._id, `${location}._id`),
        telegramUserId: readSafeInteger(
            record.entity_id,
            `${location}.entity_id`,
            1
        ),
        displayName: readNonEmptyString(record.name, `${location}.name`, 512)
    };
};

const validateScoreRecord = (
    value: unknown,
    location: string
): MongoScoreRecord => {
    const record = readRecord(value, location);

    return {
        mongoId: readMongoOid(record._id, `${location}._id`),
        channelMongoId: readMongoOid(
            record.channel_id,
            `${location}.channel_id`
        ),
        playerMongoId: readMongoOid(record.player_id, `${location}.player_id`),
        score: readSafeInteger(record.score, `${location}.score`, 0)
    };
};

const validateStatusRecord = (
    value: unknown,
    location: string
): MongoStatusRecord => {
    const record = readRecord(value, location);

    return {
        mongoId: readMongoOid(record._id, `${location}._id`),
        channelMongoId: readMongoOid(
            record.channel_id,
            `${location}.channel_id`
        ),
        playerMongoId: readMongoOid(record.player_id, `${location}.player_id`),
        isActive: readBoolean(record.status, `${location}.status`),
        isAutoJoined: readBoolean(record.auto, `${location}.auto`)
    };
};

const parseJsonRecords = (content: string, fileName: string) => {
    const trimmedContent = content.trim();

    if (!trimmedContent) {
        throw new Error(`Mongo export file ${fileName} is empty`);
    }

    if (trimmedContent.startsWith('[')) {
        let parsed: unknown;

        try {
            parsed = JSON.parse(trimmedContent) as unknown;
        } catch (error) {
            throw new Error(
                `Mongo export file ${fileName} contains malformed JSON: ${String(error)}`
            );
        }

        if (!Array.isArray(parsed)) {
            throw new Error(
                `Mongo export file ${fileName} must contain a JSON array`
            );
        }

        return {
            format: 'json-array' as const,
            records: parsed
        };
    }

    const records: unknown[] = [];
    const lines = content.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]?.trim() ?? '';

        if (!line) {
            continue;
        }

        try {
            records.push(JSON.parse(line) as unknown);
        } catch (error) {
            throw new Error(
                `Mongo export file ${fileName} has malformed NDJSON at line ${index + 1}: ${String(error)}`
            );
        }
    }

    return {
        format: 'ndjson' as const,
        records
    };
};

const parseSourceFile = <T>(
    sourceFile: LoadedSourceFile,
    collection: SourceCollection,
    validate: (value: unknown, location: string) => T
): ParsedSourceFile<T> => {
    let content: string;

    try {
        content = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: false
        }).decode(sourceFile.bytes);
    } catch {
        throw new Error(
            `Mongo export file ${sourceFile.name} is not valid UTF-8`
        );
    }

    const parsed = parseJsonRecords(content, sourceFile.name);
    const records = parsed.records.map((record, index) => {
        return validate(record, `${collection}[${index}]`);
    });

    return {
        records,
        report: {
            name: sourceFile.name,
            format: parsed.format,
            byteLength: sourceFile.bytes.byteLength,
            declaredByteLength: sourceFile.declaredByteLength,
            sha256: sourceFile.sha256,
            blobSha: sourceFile.blobSha,
            recordCount: records.length
        }
    };
};

const hashBytes = (bytes: Uint8Array) => {
    return createHash('sha256').update(bytes).digest('hex');
};

const hashGitBlob = (bytes: Uint8Array) => {
    return createHash('sha1')
        .update(`blob ${bytes.byteLength}\0`)
        .update(bytes)
        .digest('hex');
};

const loadDirectoryFile = (
    directory: string,
    collection: SourceCollection
): LoadedSourceFile => {
    const candidateNames = sourceFileNames[collection];
    const matchingNames = candidateNames.filter(fileName => {
        const filePath = path.join(directory, fileName);

        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    });

    if (matchingNames.length !== 1) {
        throw new Error(
            matchingNames.length === 0
                ? `Missing ${collection} export; expected ${candidateNames.join(' or ')} in ${directory}`
                : `Ambiguous ${collection} export; keep only one of ${candidateNames.join(' or ')}`
        );
    }

    const name = matchingNames[0];

    if (!name) {
        throw new Error(`Failed to resolve ${collection} export file`);
    }

    const bytes = Uint8Array.from(fs.readFileSync(path.join(directory, name)));

    if (bytes.byteLength > maximumSourceFileBytes) {
        throw new Error(
            `Mongo export file ${name} exceeds the ${maximumSourceFileBytes}-byte safety limit`
        );
    }

    return {
        name,
        bytes,
        sha256: hashBytes(bytes),
        blobSha: null,
        declaredByteLength: bytes.byteLength
    };
};

const loadDirectorySource = (directory: string): LoadedSourceFiles => {
    const resolvedDirectory = path.resolve(directory);

    if (
        !fs.existsSync(resolvedDirectory) ||
        !fs.statSync(resolvedDirectory).isDirectory()
    ) {
        throw new Error(
            `Mongo export directory does not exist: ${resolvedDirectory}`
        );
    }

    return {
        channels: loadDirectoryFile(resolvedDirectory, 'channels'),
        players: loadDirectoryFile(resolvedDirectory, 'players'),
        scores: loadDirectoryFile(resolvedDirectory, 'scores'),
        statuses: loadDirectoryFile(resolvedDirectory, 'statuses')
    };
};

const validateGithubRepository = (repository: string) => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
        throw new Error('GitHub repository must use the owner/name format');
    }

    return repository;
};

const containsAsciiControlCharacter = (value: string) => {
    for (const character of value) {
        if (character.charCodeAt(0) < 32) {
            return true;
        }
    }

    return false;
};

const validateGithubRef = (ref: string, requireCommitSha: boolean) => {
    const trimmedRef = ref.trim();

    if (
        !trimmedRef ||
        trimmedRef.length > 200 ||
        containsAsciiControlCharacter(trimmedRef)
    ) {
        throw new Error(
            'GitHub source ref must be a non-empty branch, tag, or SHA'
        );
    }

    if (requireCommitSha && !/^[0-9a-f]{40}$/i.test(trimmedRef)) {
        throw new Error(
            'Production Mongo import requires an immutable 40-character Git commit SHA'
        );
    }

    return trimmedRef;
};

export const createGithubCliTokenEnvironment = (
    source: Readonly<Record<string, string | undefined>>
) => {
    const environment: Record<string, string> = {};

    for (const [name, value] of Object.entries(source)) {
        if (value !== undefined && githubCliEnvironmentKeys.has(name)) {
            environment[name] = value;
        }
    }

    return environment;
};

export const getGithubCliTokenArguments = () => {
    return ['auth', 'token', '--hostname', 'github.com'];
};

const resolveGithubToken = (explicitToken?: string) => {
    const environmentToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const token = explicitToken || environmentToken;

    if (token) {
        const trimmedToken = token.trim();

        if (!trimmedToken || /\s/.test(trimmedToken)) {
            throw new Error('GitHub token contains invalid whitespace');
        }

        return trimmedToken;
    }

    const result = spawnSync('gh', getGithubCliTokenArguments(), {
        encoding: 'utf8',
        env: createGithubCliTokenEnvironment(
            process.env
        ) as unknown as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'ignore']
    });
    const ghToken = result.status === 0 ? result.stdout.trim() : '';

    if (!ghToken || /\s/.test(ghToken)) {
        throw new Error(
            'Private GitHub source requires GH_TOKEN, GITHUB_TOKEN, or an authenticated gh CLI'
        );
    }

    return ghToken;
};

const readLimitedResponse = async (
    response: Response,
    maximumBytes: number,
    description: string
) => {
    const contentLength = response.headers.get('Content-Length');

    if (contentLength) {
        const parsedLength = Number(contentLength);

        if (
            !Number.isSafeInteger(parsedLength) ||
            parsedLength > maximumBytes
        ) {
            throw new Error(
                `${description} exceeds the ${maximumBytes}-byte limit`
            );
        }
    }

    if (!response.body) {
        throw new Error(`${description} returned no response body`);
    }

    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    let receivedBytes = 0;

    while (true) {
        const result = await reader.read();

        if (result.done) {
            break;
        }

        receivedBytes += result.value.byteLength;

        if (receivedBytes > maximumBytes) {
            await reader.cancel();
            throw new Error(
                `${description} exceeds the ${maximumBytes}-byte limit`
            );
        }

        chunks.push(result.value);
    }

    const bytes = new Uint8Array(receivedBytes);
    let offset = 0;

    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return bytes;
};

const fetchGithub = async (
    fetchImplementation: typeof fetch,
    url: string,
    token: string,
    maximumBytes: number,
    description: string,
    accept: string
) => {
    const parsedUrl = new URL(url);

    if (
        parsedUrl.origin !== githubApiOrigin ||
        parsedUrl.username ||
        parsedUrl.password
    ) {
        throw new Error(
            'Refusing to forward GitHub credentials outside api.github.com'
        );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, githubRequestTimeoutMilliseconds);

    try {
        const response = await fetchImplementation(url, {
            headers: {
                Accept: accept,
                Authorization: `Bearer ${token}`,
                'User-Agent': 'princess-mongo-to-d1-migration',
                'X-GitHub-Api-Version': '2026-03-10'
            },
            redirect: 'error',
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(
                `${description} failed with GitHub HTTP ${response.status}`
            );
        }

        return readLimitedResponse(response, maximumBytes, description);
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(
                `${description} timed out after ${githubRequestTimeoutMilliseconds}ms`
            );
        }

        throw error;
    } finally {
        clearTimeout(timeout);
    }
};

const decodeJson = (bytes: Uint8Array, description: string): unknown => {
    try {
        const content = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: false
        }).decode(bytes);

        return JSON.parse(content) as unknown;
    } catch (error) {
        throw new Error(
            `${description} returned invalid JSON: ${String(error)}`
        );
    }
};

const loadGithubSource = async (
    source: Extract<MongoImportSource, { kind: 'github' }>,
    fetchImplementation: typeof fetch,
    explicitToken?: string
) => {
    const repository = validateGithubRepository(
        source.repository ?? defaultGithubRepository
    );

    if (source.requireCommitSha && repository !== defaultGithubRepository) {
        throw new Error(
            `Production Mongo import source must be ${defaultGithubRepository}`
        );
    }

    const requestedRef = validateGithubRef(
        source.ref,
        source.requireCommitSha ?? false
    );
    const token = resolveGithubToken(explicitToken);
    const encodedRepository = repository
        .split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/');
    const commitBytes = await fetchGithub(
        fetchImplementation,
        `${githubApiOrigin}/repos/${encodedRepository}/commits/${encodeURIComponent(requestedRef)}`,
        token,
        1024 * 1024,
        `GitHub commit ${repository}@${requestedRef}`,
        'application/vnd.github+json'
    );
    const commitPayload = decodeJson(commitBytes, 'GitHub commit response');
    const commitRecord = readRecord(commitPayload, 'GitHub commit response');
    const resolvedCommitSha = commitRecord.sha;

    if (
        typeof resolvedCommitSha !== 'string' ||
        !/^[0-9a-f]{40}$/i.test(resolvedCommitSha)
    ) {
        throw new Error(
            'GitHub commit response did not contain a valid commit SHA'
        );
    }

    let totalSourceBytes = 0;

    const fetchSourceFile = async (
        collection: SourceCollection
    ): Promise<LoadedSourceFile> => {
        const name = sourceFileNames[collection][0];

        if (!name) {
            throw new Error(`No allowlisted file configured for ${collection}`);
        }

        const contentsUrl = `${githubApiOrigin}/repos/${encodedRepository}/contents/${encodeURIComponent(name)}?ref=${encodeURIComponent(resolvedCommitSha)}`;
        const metadataBytes = await fetchGithub(
            fetchImplementation,
            contentsUrl,
            token,
            maximumGithubMetadataBytes,
            `GitHub source metadata ${name}`,
            'application/vnd.github+json'
        );
        const metadata = readRecord(
            decodeJson(metadataBytes, `GitHub source metadata ${name}`),
            `GitHub source metadata ${name}`
        );
        const blobSha = metadata.sha;
        const declaredByteLength = metadata.size;

        if (metadata.name !== name || metadata.type !== 'file') {
            throw new Error(
                `GitHub source metadata for ${name} is not the expected file`
            );
        }

        if (typeof blobSha !== 'string' || !/^[0-9a-f]{40}$/i.test(blobSha)) {
            throw new Error(
                `GitHub source metadata for ${name} has an invalid blob SHA`
            );
        }

        if (
            !Number.isSafeInteger(declaredByteLength) ||
            (declaredByteLength as number) < 0 ||
            (declaredByteLength as number) > maximumSourceFileBytes ||
            totalSourceBytes + (declaredByteLength as number) >
                maximumTotalSourceBytes
        ) {
            throw new Error(
                `GitHub source metadata for ${name} has an unsafe file size`
            );
        }

        const bytes = await fetchGithub(
            fetchImplementation,
            contentsUrl,
            token,
            Math.min(
                maximumSourceFileBytes,
                maximumTotalSourceBytes - totalSourceBytes
            ),
            `GitHub source file ${name}`,
            'application/vnd.github.raw+json'
        );

        if (bytes.byteLength !== declaredByteLength) {
            throw new Error(
                `GitHub source file ${name} size ${bytes.byteLength} does not match metadata size ${declaredByteLength}`
            );
        }

        if (hashGitBlob(bytes) !== blobSha.toLowerCase()) {
            throw new Error(
                `GitHub source file ${name} does not match metadata blob SHA`
            );
        }

        totalSourceBytes += bytes.byteLength;

        return {
            name,
            bytes,
            sha256: hashBytes(bytes),
            blobSha: blobSha.toLowerCase(),
            declaredByteLength: declaredByteLength as number
        };
    };

    const channels = await fetchSourceFile('channels');
    const players = await fetchSourceFile('players');
    const scores = await fetchSourceFile('scores');
    const statuses = await fetchSourceFile('statuses');

    return {
        files: {
            channels,
            players,
            scores,
            statuses
        },
        repository,
        requestedRef,
        resolvedCommitSha: resolvedCommitSha.toLowerCase()
    };
};

const parseCollections = (files: LoadedSourceFiles): ParsedCollections => {
    return {
        channels: parseSourceFile(
            files.channels,
            'channels',
            validateChannelRecord
        ),
        players: parseSourceFile(
            files.players,
            'players',
            validatePlayerRecord
        ),
        scores: parseSourceFile(files.scores, 'scores', validateScoreRecord),
        statuses: parseSourceFile(
            files.statuses,
            'statuses',
            validateStatusRecord
        )
    };
};

const createUniqueMongoIdMap = <T extends { mongoId: string }>(
    records: T[],
    collection: SourceCollection
) => {
    const recordsByMongoId = new Map<string, T>();

    for (const record of records) {
        if (recordsByMongoId.has(record.mongoId)) {
            throw new Error(
                `Duplicate ${collection} Mongo ObjectId ${record.mongoId}`
            );
        }

        recordsByMongoId.set(record.mongoId, record);
    }

    return recordsByMongoId;
};

const assertOwnership = (
    collection: 'score' | 'status',
    mongoId: string,
    actualChannelMongoId: string,
    actualPlayerMongoId: string,
    expectedChannelMongoId: string,
    expectedPlayerMongoId: string
) => {
    if (
        actualChannelMongoId !== expectedChannelMongoId ||
        actualPlayerMongoId !== expectedPlayerMongoId
    ) {
        throw new Error(
            `${collection} ${mongoId} belongs to channel/player ${actualChannelMongoId}/${actualPlayerMongoId}, not ${expectedChannelMongoId}/${expectedPlayerMongoId}`
        );
    }
};

const transformCollections = (
    collections: ParsedCollections,
    importTimestamp: number
) => {
    if (!Number.isSafeInteger(importTimestamp) || importTimestamp < 0) {
        throw new Error('Import timestamp must be a non-negative safe integer');
    }

    const playersByMongoId = createUniqueMongoIdMap(
        collections.players.records,
        'players'
    );
    const channelsByMongoId = createUniqueMongoIdMap(
        collections.channels.records,
        'channels'
    );
    const scoresByMongoId = createUniqueMongoIdMap(
        collections.scores.records,
        'scores'
    );
    const statusesByMongoId = createUniqueMongoIdMap(
        collections.statuses.records,
        'statuses'
    );
    const uniquePlayers = new Map<number, PlayerRow>();
    const uniqueChannels = new Map<number, ChannelRow>();
    const uniqueChannelMembers = new Map<string, ChannelMemberRow>();
    const referencedScoreIds = new Set<string>();
    const referencedStatusIds = new Set<string>();

    for (const player of playersByMongoId.values()) {
        if (uniquePlayers.has(player.telegramUserId)) {
            throw new Error(
                `Duplicate Telegram user ID ${player.telegramUserId}`
            );
        }

        uniquePlayers.set(player.telegramUserId, {
            telegramUserId: player.telegramUserId,
            displayName: player.displayName,
            createdAt: importTimestamp,
            updatedAt: importTimestamp
        });
    }

    for (const channel of channelsByMongoId.values()) {
        if (uniqueChannels.has(channel.telegramChatId)) {
            throw new Error(
                `Duplicate Telegram chat ID ${channel.telegramChatId}`
            );
        }

        uniqueChannels.set(channel.telegramChatId, {
            telegramChatId: channel.telegramChatId,
            language: 'ua',
            releaseVersion: channel.releaseVersion,
            lastVoteAt: channel.updatedAt,
            createdAt: importTimestamp
        });

        for (const memberReference of channel.players) {
            const player = playersByMongoId.get(memberReference.playerId);
            const score = scoresByMongoId.get(memberReference.scoreId);
            const status = statusesByMongoId.get(memberReference.statusId);

            if (!player) {
                throw new Error(
                    `Channel ${channel.mongoId} references missing player ${memberReference.playerId}`
                );
            }

            if (!score) {
                throw new Error(
                    `Channel ${channel.mongoId} references missing score ${memberReference.scoreId}`
                );
            }

            if (!status) {
                throw new Error(
                    `Channel ${channel.mongoId} references missing status ${memberReference.statusId}`
                );
            }

            assertOwnership(
                'score',
                score.mongoId,
                score.channelMongoId,
                score.playerMongoId,
                channel.mongoId,
                player.mongoId
            );
            assertOwnership(
                'status',
                status.mongoId,
                status.channelMongoId,
                status.playerMongoId,
                channel.mongoId,
                player.mongoId
            );

            if (referencedScoreIds.has(score.mongoId)) {
                throw new Error(
                    `Score ${score.mongoId} is referenced more than once`
                );
            }

            if (referencedStatusIds.has(status.mongoId)) {
                throw new Error(
                    `Status ${status.mongoId} is referenced more than once`
                );
            }

            referencedScoreIds.add(score.mongoId);
            referencedStatusIds.add(status.mongoId);

            const membershipKey = `${channel.telegramChatId}:${player.telegramUserId}`;

            if (uniqueChannelMembers.has(membershipKey)) {
                throw new Error(
                    `Duplicate channel membership ${membershipKey}`
                );
            }

            uniqueChannelMembers.set(membershipKey, {
                telegramChatId: channel.telegramChatId,
                telegramUserId: player.telegramUserId,
                score: score.score,
                isActive: status.isActive,
                isAutoJoined: status.isAutoJoined,
                createdAt: importTimestamp,
                updatedAt: importTimestamp
            });
        }
    }

    const unreferencedScore = collections.scores.records.find(score => {
        return !referencedScoreIds.has(score.mongoId);
    });

    if (unreferencedScore) {
        throw new Error(
            `Score ${unreferencedScore.mongoId} is not referenced by a channel and would be skipped`
        );
    }

    const unreferencedStatus = collections.statuses.records.find(status => {
        return !referencedStatusIds.has(status.mongoId);
    });

    if (unreferencedStatus) {
        throw new Error(
            `Status ${unreferencedStatus.mongoId} is not referenced by a channel and would be skipped`
        );
    }

    return {
        playerRows: Array.from(uniquePlayers.values()).sort(
            (left, right) => left.telegramUserId - right.telegramUserId
        ),
        channelRows: Array.from(uniqueChannels.values()).sort(
            (left, right) => left.telegramChatId - right.telegramChatId
        ),
        channelMemberRows: Array.from(uniqueChannelMembers.values()).sort(
            (left, right) => {
                if (left.telegramChatId === right.telegramChatId) {
                    return left.telegramUserId - right.telegramUserId;
                }

                return left.telegramChatId - right.telegramChatId;
            }
        )
    };
};

const chunk = <T>(items: T[], size: number): T[][] => {
    const chunks: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }

    return chunks;
};

const escapeSqlString = (value: string): string => value.replaceAll("'", "''");
const quoteString = (value: string): string => `'${escapeSqlString(value)}'`;

const quoteNullableNumber = (value: number | null): string => {
    return value === null ? 'NULL' : `${value}`;
};

const quoteBoolean = (value: boolean): string => {
    return value ? '1' : '0';
};

const formatPlayerInsertStatement = (rows: PlayerRow[]): string => {
    const values = rows.map(row => {
        return `(${row.telegramUserId}, ${quoteString(row.displayName)}, ${row.createdAt}, ${row.updatedAt})`;
    });

    return [
        'INSERT INTO "players" ("telegram_user_id", "display_name", "created_at", "updated_at")',
        `VALUES ${values.join(',\n')};`
    ].join('\n');
};

const formatChannelInsertStatement = (rows: ChannelRow[]): string => {
    const values = rows.map(row => {
        return `(${row.telegramChatId}, ${quoteString(row.language)}, ${quoteString(row.releaseVersion)}, ${quoteNullableNumber(row.lastVoteAt)}, ${row.createdAt})`;
    });

    return [
        'INSERT INTO "channels" ("telegram_chat_id", "language", "release_version", "last_vote_at", "created_at")',
        `VALUES ${values.join(',\n')};`
    ].join('\n');
};

const formatChannelMemberInsertStatement = (
    rows: ChannelMemberRow[]
): string => {
    const values = rows.map(row => {
        return [
            '(',
            `    (SELECT "id" FROM "channels" WHERE "telegram_chat_id" = ${row.telegramChatId}),`,
            `    (SELECT "id" FROM "players" WHERE "telegram_user_id" = ${row.telegramUserId}),`,
            `    ${row.score},`,
            `    ${quoteBoolean(row.isActive)},`,
            `    ${quoteBoolean(row.isAutoJoined)},`,
            `    ${row.createdAt},`,
            `    ${row.updatedAt}`,
            ')'
        ].join('\n');
    });

    return [
        'INSERT INTO "channel_members" ("channel_id", "player_id", "score", "is_active", "is_auto_joined", "created_at", "updated_at")',
        `VALUES ${values.join(',\n')};`
    ].join('\n');
};

export const formatImportSql = (
    playerRows: PlayerRow[],
    channelRows: ChannelRow[],
    channelMemberRows: ChannelMemberRow[]
): string => {
    const sqlStatements = [
        '-- Generated from validated Mongo export files.',
        '-- Expected flow: apply schema migration and prove application tables are empty before import.',
        '-- Inserts are intentionally fail-closed; rerunning against populated tables must not overwrite live state.',
        '-- Explicit BEGIN/COMMIT are omitted because wrangler d1 execute --file manages the remote import transaction.',
        'PRAGMA foreign_keys = ON;'
    ];
    const addInsertStatement = (statement: string) => {
        if (
            new TextEncoder().encode(statement).byteLength >
            maximumD1StatementBytes
        ) {
            throw new Error(
                `Generated D1 statement exceeds the ${maximumD1StatementBytes}-byte safety limit`
            );
        }

        sqlStatements.push(statement);
    };

    for (const playerRowsChunk of chunk(playerRows, playerChunkSize)) {
        addInsertStatement(formatPlayerInsertStatement(playerRowsChunk));
    }

    for (const channelRowsChunk of chunk(channelRows, channelChunkSize)) {
        addInsertStatement(formatChannelInsertStatement(channelRowsChunk));
    }

    for (const channelMemberRowsChunk of chunk(
        channelMemberRows,
        channelMemberChunkSize
    )) {
        addInsertStatement(
            formatChannelMemberInsertStatement(channelMemberRowsChunk)
        );
    }

    return `${sqlStatements.join('\n\n')}\n`;
};

const getFilesReport = (collections: ParsedCollections): SourceFilesReport => {
    return {
        channels: collections.channels.report,
        players: collections.players.report,
        scores: collections.scores.report,
        statuses: collections.statuses.report
    };
};

export const prepareMongoImport = async (
    options: PrepareMongoImportOptions
): Promise<ImportReport> => {
    const outputDirectory = path.resolve(
        options.outputDirectory ?? path.resolve(process.cwd(), '.backups')
    );
    const outputSqlPath = path.join(outputDirectory, 'mongo-to-d1.sql');
    const outputReportPath = path.join(
        outputDirectory,
        'mongo-to-d1.report.json'
    );

    fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    fs.rmSync(outputSqlPath, { force: true });
    fs.rmSync(outputReportPath, { force: true });

    let files: LoadedSourceFiles;
    let sourceDetails:
        | { kind: 'directory'; directory: string }
        | {
              kind: 'github';
              repository: string;
              requestedRef: string;
              resolvedCommitSha: string;
          };

    if (options.source.kind === 'directory') {
        const directory = path.resolve(options.source.directory);
        files = loadDirectorySource(directory);
        sourceDetails = {
            kind: 'directory',
            directory
        };
    } else {
        const githubSource = await loadGithubSource(
            options.source,
            options.fetchImplementation ?? fetch,
            options.githubToken
        );
        files = githubSource.files;
        sourceDetails = {
            kind: 'github',
            repository: githubSource.repository,
            requestedRef: githubSource.requestedRef,
            resolvedCommitSha: githubSource.resolvedCommitSha
        };
    }

    const collections = parseCollections(files);
    const transformed = transformCollections(
        collections,
        options.importTimestamp ?? Date.now()
    );
    const filesReport = getFilesReport(collections);
    const source: ImportSourceReport =
        sourceDetails.kind === 'directory'
            ? {
                  ...sourceDetails,
                  files: filesReport
              }
            : {
                  ...sourceDetails,
                  files: filesReport
              };
    const report: ImportReport = {
        source,
        outputSqlPath,
        outputReportPath,
        sourceCounts: {
            channels: collections.channels.records.length,
            players: collections.players.records.length,
            scores: collections.scores.records.length,
            statuses: collections.statuses.records.length
        },
        transformedCounts: {
            channels: transformed.channelRows.length,
            players: transformed.playerRows.length,
            channelMembers: transformed.channelMemberRows.length
        },
        validation: {
            validated: true,
            duplicates: 0,
            unresolvedReferences: 0,
            ownershipMismatches: 0,
            skippedRecords: 0
        }
    };

    fs.writeFileSync(
        outputSqlPath,
        formatImportSql(
            transformed.playerRows,
            transformed.channelRows,
            transformed.channelMemberRows
        ),
        { encoding: 'utf8', mode: 0o600 }
    );
    fs.writeFileSync(outputReportPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
    });

    return report;
};

export const getDefaultGithubRepository = () => defaultGithubRepository;
