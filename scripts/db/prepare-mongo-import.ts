import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

interface MongoOid {
    $oid: string;
}

interface MongoDate {
    $date: string;
}

interface MongoChannelPlayerReference {
    player_id: MongoOid;
    score_id: MongoOid;
    status_id: MongoOid;
}

interface MongoChannelRecord {
    _id: MongoOid;
    entity_id: number;
    updated_at: MongoDate | null;
    release: string;
    players: MongoChannelPlayerReference[];
}

interface MongoPlayerRecord {
    _id: MongoOid;
    entity_id: number;
    name: string;
}

interface MongoScoreRecord {
    _id: MongoOid;
    channel_id: MongoOid;
    player_id: MongoOid;
    score: number;
}

interface MongoStatusRecord {
    _id: MongoOid;
    channel_id: MongoOid;
    player_id: MongoOid;
    status: boolean;
    auto: boolean;
}

interface PlayerRow {
    telegramUserId: number;
    displayName: string;
    createdAt: number;
    updatedAt: number;
}

interface ChannelRow {
    telegramChatId: number;
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

interface ImportReport {
    backupDir: string;
    outputSqlPath: string;
    outputReportPath: string;
    sourceCounts: {
        channels: number;
        players: number;
        scores: number;
        statuses: number;
    };
    transformedCounts: {
        channels: number;
        players: number;
        channelMembers: number;
    };
    skipped: {
        duplicateChannels: number;
        duplicatePlayers: number;
        duplicateChannelMembers: number;
        missingPlayerRefs: number;
        missingScoreRefs: number;
        missingStatusRefs: number;
    };
}

const backupDir =
    process.env.MONGO_BACKUP_DIR || path.resolve(process.cwd(), 'princess-db');
const outputSqlPath = path.resolve(process.cwd(), '.backups/mongo-to-d1.sql');
const outputReportPath = path.resolve(
    process.cwd(),
    '.backups/mongo-to-d1.report.json'
);

const playerChunkSize = 20;
const channelChunkSize = 20;
const channelMemberChunkSize = 10;
const importTimestamp = Date.now();

const readNdjsonFile = async <T>(filePath: string): Promise<T[]> => {
    const records: T[] = [];
    const stream = fs.createReadStream(filePath, 'utf8');
    const reader = readline.createInterface({
        input: stream,
        crlfDelay: Infinity
    });

    for await (const line of reader) {
        const trimmedLine = line.trim();

        if (!trimmedLine) {
            continue;
        }

        records.push(JSON.parse(trimmedLine) as T);
    }

    return records;
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
    if (value === null) {
        return 'NULL';
    }

    return `${value}`;
};

const quoteBoolean = (value: boolean): string => {
    if (value) {
        return '1';
    }

    return '0';
};

const formatDateAsTimestampMs = (value: MongoDate | null): number | null => {
    if (!value) {
        return null;
    }

    return new Date(value.$date).getTime();
};

const formatPlayerInsertStatement = (rows: PlayerRow[]): string => {
    const values = rows.map(row => {
        return `(${row.telegramUserId}, ${quoteString(row.displayName)}, ${row.createdAt}, ${row.updatedAt})`;
    });

    return [
        'INSERT INTO "players" ("telegram_user_id", "display_name", "created_at", "updated_at")',
        `VALUES ${values.join(',\n')}`,
        'ON CONFLICT("telegram_user_id") DO UPDATE SET',
        '"display_name" = excluded."display_name",',
        '"updated_at" = excluded."updated_at";'
    ].join('\n');
};

const formatChannelInsertStatement = (rows: ChannelRow[]): string => {
    const values = rows.map(row => {
        return `(${row.telegramChatId}, ${quoteString(row.releaseVersion)}, ${quoteNullableNumber(row.lastVoteAt)}, ${row.createdAt})`;
    });

    return [
        'INSERT INTO "channels" ("telegram_chat_id", "release_version", "last_vote_at", "created_at")',
        `VALUES ${values.join(',\n')}`,
        'ON CONFLICT("telegram_chat_id") DO UPDATE SET',
        '"release_version" = excluded."release_version",',
        '"last_vote_at" = excluded."last_vote_at";'
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
        `VALUES ${values.join(',\n')}`,
        'ON CONFLICT("channel_id", "player_id") DO UPDATE SET',
        '"score" = excluded."score",',
        '"is_active" = excluded."is_active",',
        '"is_auto_joined" = excluded."is_auto_joined",',
        '"updated_at" = excluded."updated_at";'
    ].join('\n');
};

const run = async () => {
    const channelsFilePath = path.join(backupDir, 'channels.json');
    const playersFilePath = path.join(backupDir, 'players.json');
    const scoresFilePath = path.join(backupDir, 'scores.json');
    const statusesFilePath = path.join(backupDir, 'status.json');

    const channelsRecords =
        await readNdjsonFile<MongoChannelRecord>(channelsFilePath);
    const playersRecords =
        await readNdjsonFile<MongoPlayerRecord>(playersFilePath);
    const scoresRecords =
        await readNdjsonFile<MongoScoreRecord>(scoresFilePath);
    const statusesRecords =
        await readNdjsonFile<MongoStatusRecord>(statusesFilePath);

    const playersByMongoId = new Map<string, MongoPlayerRecord>();
    const scoresByMongoId = new Map<string, MongoScoreRecord>();
    const statusesByMongoId = new Map<string, MongoStatusRecord>();

    let duplicatePlayers = 0;
    let duplicateChannels = 0;
    let duplicateChannelMembers = 0;
    let missingPlayerRefs = 0;
    let missingScoreRefs = 0;
    let missingStatusRefs = 0;

    for (const player of playersRecords) {
        const mongoPlayerId = player._id.$oid;

        if (playersByMongoId.has(mongoPlayerId)) {
            duplicatePlayers += 1;
            continue;
        }

        playersByMongoId.set(mongoPlayerId, player);
    }

    for (const score of scoresRecords) {
        scoresByMongoId.set(score._id.$oid, score);
    }

    for (const status of statusesRecords) {
        statusesByMongoId.set(status._id.$oid, status);
    }

    const uniquePlayers = new Map<number, PlayerRow>();
    const uniqueChannels = new Map<number, ChannelRow>();
    const uniqueChannelMembers = new Map<string, ChannelMemberRow>();

    for (const player of playersRecords) {
        if (uniquePlayers.has(player.entity_id)) {
            duplicatePlayers += 1;
            continue;
        }

        uniquePlayers.set(player.entity_id, {
            telegramUserId: player.entity_id,
            displayName: player.name,
            createdAt: importTimestamp,
            updatedAt: importTimestamp
        });
    }

    for (const channel of channelsRecords) {
        if (uniqueChannels.has(channel.entity_id)) {
            duplicateChannels += 1;
            continue;
        }

        uniqueChannels.set(channel.entity_id, {
            telegramChatId: channel.entity_id,
            releaseVersion: channel.release,
            lastVoteAt: formatDateAsTimestampMs(channel.updated_at),
            createdAt: importTimestamp
        });

        for (const memberReference of channel.players) {
            const player = playersByMongoId.get(memberReference.player_id.$oid);
            const score = scoresByMongoId.get(memberReference.score_id.$oid);
            const status = statusesByMongoId.get(
                memberReference.status_id.$oid
            );

            if (!player) {
                missingPlayerRefs += 1;
                continue;
            }

            if (!score) {
                missingScoreRefs += 1;
                continue;
            }

            if (!status) {
                missingStatusRefs += 1;
                continue;
            }

            const membershipKey = `${channel.entity_id}:${player.entity_id}`;

            if (uniqueChannelMembers.has(membershipKey)) {
                duplicateChannelMembers += 1;
                continue;
            }

            uniqueChannelMembers.set(membershipKey, {
                telegramChatId: channel.entity_id,
                telegramUserId: player.entity_id,
                score: score.score,
                isActive: status.status,
                isAutoJoined: status.auto,
                createdAt: importTimestamp,
                updatedAt: importTimestamp
            });
        }
    }

    const playerRows = Array.from(uniquePlayers.values()).sort(
        (left, right) => left.telegramUserId - right.telegramUserId
    );
    const channelRows = Array.from(uniqueChannels.values()).sort(
        (left, right) => left.telegramChatId - right.telegramChatId
    );
    const channelMemberRows = Array.from(uniqueChannelMembers.values()).sort(
        (left, right) => {
            if (left.telegramChatId === right.telegramChatId) {
                return left.telegramUserId - right.telegramUserId;
            }

            return left.telegramChatId - right.telegramChatId;
        }
    );

    const sqlStatements = [
        '-- Generated from Mongo backup NDJSON files.',
        '-- Expected flow: apply schema migration first, then execute this import file.',
        'PRAGMA foreign_keys = ON;',
        'BEGIN TRANSACTION;'
    ];

    for (const playerRowsChunk of chunk(playerRows, playerChunkSize)) {
        sqlStatements.push(formatPlayerInsertStatement(playerRowsChunk));
    }

    for (const channelRowsChunk of chunk(channelRows, channelChunkSize)) {
        sqlStatements.push(formatChannelInsertStatement(channelRowsChunk));
    }

    for (const channelMemberRowsChunk of chunk(
        channelMemberRows,
        channelMemberChunkSize
    )) {
        sqlStatements.push(
            formatChannelMemberInsertStatement(channelMemberRowsChunk)
        );
    }

    sqlStatements.push('COMMIT;');

    const report: ImportReport = {
        backupDir,
        outputSqlPath,
        outputReportPath,
        sourceCounts: {
            channels: channelsRecords.length,
            players: playersRecords.length,
            scores: scoresRecords.length,
            statuses: statusesRecords.length
        },
        transformedCounts: {
            channels: channelRows.length,
            players: playerRows.length,
            channelMembers: channelMemberRows.length
        },
        skipped: {
            duplicateChannels,
            duplicatePlayers,
            duplicateChannelMembers,
            missingPlayerRefs,
            missingScoreRefs,
            missingStatusRefs
        }
    };

    fs.mkdirSync(path.dirname(outputSqlPath), {
        recursive: true
    });
    fs.writeFileSync(outputSqlPath, `${sqlStatements.join('\n\n')}\n`, 'utf8');
    fs.writeFileSync(
        outputReportPath,
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8'
    );

    console.log(JSON.stringify(report, null, 2));
};

void run();
