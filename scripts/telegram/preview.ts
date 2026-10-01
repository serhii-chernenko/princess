import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { TELEGRAM_SECRET_HEADER } from '../../src/worker/telegram-auth';

import { createWebhookUrl, requireEnv } from '../cloudflare/runtime-env';
import {
    loadPreviewEnvironment,
    PreviewOperatorError,
    requirePreviewBot as requirePreviewBotIdentity,
    runLocalCommand,
    type RunCommand
} from './preview-environment';
import {
    ACCOUNT_SUBDOMAIN,
    callTelegramApi,
    formatTelegramWebhookInfo,
    parsePreviewBaseUrl,
    readConfiguredWebhookOrigin,
    readWebhookInfo,
    setTelegramWebhook,
    summarizeTelegramWebhookInfo,
    type TelegramApiCallOptions,
    type TelegramApiPayload,
    WORKER_NAME
} from './webhook';

export const LONG_LIVED_PREVIEW_ORIGIN = `https://preview-${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev`;
export const BUILDS_BOT_LOGIN = 'cloudflare-workers-and-pages[bot]';
export const BUILDS_BOT_TYPE = 'Bot';
export const MAX_DNS_LABEL_LENGTH = 63;
export const DEFAULT_TIMEOUT_SECONDS = 600;
export const DEFAULT_READY_TIMEOUT_SECONDS = 120;
export const DEFAULT_INTERVAL_SECONDS = 10;
export const MAX_CONSECUTIVE_BUILD_LOOKUP_FAILURES = 5;
export const REQUEST_TIMEOUT_MILLISECONDS = 15_000;
export const MAX_READINESS_BODY_BYTES = 64 * 1024;
export const SYNTHETIC_PRIVATE_CHAT_NAME = 'Preview Smoke';
export const SYNTHETIC_GROUP_SENDER_ID = 424_242_424;
export const SYNTHETIC_MESSAGE_ID = 1;

export {
    loadPreviewEnvironment,
    PREVIEW_BOT_USERNAME,
    PREVIEW_ENVIRONMENT_KEYS,
    PreviewOperatorError,
    resolveMainWorktreeRoot,
    runLocalCommand,
    type RunCommand
} from './preview-environment';

const GH_PAGE_SIZE = 100;
const MAX_PULL_REQUESTS_INSPECTED = 3;
const SMOKE_COMMAND_TEXT = '/start';
const PREVIEW_ENVIRONMENT_COMMANDS = ['wait', 'point', 'smoke', 'reset'];
const buildCheckNamePattern = /workers builds/i;
const previewUrlHeaderPattern = /^### Preview URL:\s*(\S+)/m;
const commitHashLabelPattern = new RegExp(`^[0-9a-f]{8}-${WORKER_NAME}$`);
const missingEnvironmentMessagePattern =
    /^Missing required environment variable: [A-Z_]+$/;
const telegramFailureMessagePattern = /^Telegram API [A-Za-z]+ failed: (.*)$/s;
const safeTelegramDescriptionPattern = /^[A-Za-z0-9 :,.'_-]{1,120}$/;
const previewHostPattern = new RegExp(
    `^[a-z0-9-]+-${WORKER_NAME}\\.${ACCOUNT_SUBDOMAIN}\\.workers\\.dev$`
);
const workersDevUrlPattern =
    /https:\/\/[a-z0-9.-]+\.workers\.dev(?![a-z0-9-]|\.[a-z0-9])/i;

export const USAGE = [
    'Usage: tsx scripts/telegram/preview.ts <command> [options]',
    '',
    'Commands:',
    '  url [--branch <name>]',
    '      Print the preview origin for the current (or given) branch.',
    '  wait [--timeout-seconds N] [--ready-timeout-seconds N] [--interval-seconds N]',
    '      Wait for the Workers Builds check on the pushed HEAD (default 600s),',
    '      then for the preview to answer (default 120s).',
    '  point [--drop-pending-updates=true|false] [--no-wait]',
    '      Resolve the preview, wait for it, and point the preview bot webhook at it.',
    '  smoke --chat-id <id> [--user-id <id>] [--url <origin>]',
    '      Opt-in. Sends a synthetic /start update to the preview webhook, so the',
    '      preview bot may reply in that chat. Use only a preview-only chat.',
    '      HTTP 200 only proves the Worker accepted the update.',
    '  reset [--drop-pending-updates=true|false]',
    `      Point the preview bot webhook back at ${LONG_LIVED_PREVIEW_ORIGIN}.`
].join('\n');

export interface PreviewDependencies {
    runCommand: RunCommand;
    fetchImplementation: typeof fetch;
    now: () => number;
    sleep: (milliseconds: number) => Promise<void>;
    write: (line: string) => void;
    telegram: TelegramApiCallOptions;
}

export interface PollingOptions {
    deadline: number;
    intervalMilliseconds: number;
}

export interface CheckRun {
    name: string;
    status: string;
    conclusion: string | null;
}

export interface CommitStatus {
    context: string;
    state: string;
}

export interface CommitChecks {
    checkRuns: CheckRun[];
    statuses: CommitStatus[];
}

export type BuildState = 'missing' | 'pending' | 'success' | 'failed';

export interface BuildEvaluation {
    state: BuildState;
    outcome: string | null;
}

export class PreviewLabelTooLongError extends PreviewOperatorError {
    constructor(message: string) {
        super(message);
        this.name = 'PreviewLabelTooLongError';
    }
}

export class PreviewUsageError extends PreviewOperatorError {
    constructor(message: string) {
        super(message);
        this.name = 'PreviewUsageError';
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const readString = (value: unknown) => {
    return typeof value === 'string' ? value : null;
};

export const createBranchSlug = (branch: string) => {
    const slug = branch.toLowerCase().replace(/[^a-z0-9]/g, '-');

    if (!/^[a-z]/.test(slug)) {
        throw new PreviewOperatorError(
            'Branch names must start with a letter to get a Cloudflare preview URL'
        );
    }

    return slug;
};

export const createPreviewOrigin = (branch: string) => {
    const label = `${createBranchSlug(branch)}-${WORKER_NAME}`;

    if (label.length > MAX_DNS_LABEL_LENGTH) {
        throw new PreviewLabelTooLongError(
            `The preview name for this branch is too long to compute locally (${label.length} characters, over the ${MAX_DNS_LABEL_LENGTH}-character DNS limit; Cloudflare shortens such names and adds a hash). Take the URL from the Workers Builds comment on the pull request and run pnpm telegram:webhook:set:preview --url <url>.`
        );
    }

    return parsePreviewBaseUrl(
        `https://${label}.${ACCOUNT_SUBDOMAIN}.workers.dev`
    );
};

export const isPreviewHostname = (hostname: string) => {
    return previewHostPattern.test(hostname);
};

export const parsePreviewUrlHeader = (body: string | null | undefined) => {
    const token = previewUrlHeaderPattern.exec(body ?? '')?.[1];
    const urlMatch =
        token === undefined ? null : workersDevUrlPattern.exec(token);

    if (urlMatch === null) {
        return undefined;
    }

    const { hostname } = new URL(urlMatch[0]);
    const label = hostname.split('.')[0] ?? '';

    if (!isPreviewHostname(hostname) || commitHashLabelPattern.test(label)) {
        return undefined;
    }

    return parsePreviewBaseUrl(`https://${hostname}`);
};

const parseSeconds = (value: string, flag: string) => {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new PreviewUsageError(`${flag} must be a positive integer`);
    }

    const seconds = Number(value);

    if (seconds < 1) {
        throw new PreviewUsageError(`${flag} must be a positive integer`);
    }

    return seconds * 1000;
};

const parseSafeInteger = (
    value: string,
    flag: string,
    minimum: number | undefined
) => {
    const parsed = Number(value);

    if (
        !/^-?\d+$/.test(value) ||
        !Number.isSafeInteger(parsed) ||
        parsed === 0 ||
        (minimum !== undefined && parsed < minimum)
    ) {
        throw new PreviewUsageError(
            `${flag} must be a ${minimum === undefined ? 'non-zero' : 'positive'} integer`
        );
    }

    return parsed;
};

export const parseChatId = (value: string | undefined) => {
    if (value === undefined) {
        throw new PreviewUsageError('smoke requires --chat-id <id>');
    }

    return parseSafeInteger(value, '--chat-id', undefined);
};

export const parseUserId = (value: string | undefined) => {
    return value === undefined
        ? undefined
        : parseSafeInteger(value, '--user-id', 1);
};

const parseBooleanValue = (value: string, flag: string) => {
    if (value !== 'true' && value !== 'false') {
        throw new PreviewUsageError(`Use ${flag}=true or ${flag}=false`);
    }

    return value === 'true';
};

const parseSmokeOrigin = (value: string) => {
    let origin: string;

    try {
        origin = parsePreviewBaseUrl(value);
    } catch (error) {
        throw new PreviewUsageError(
            error instanceof Error ? error.message : '--url is invalid'
        );
    }

    if (!isPreviewHostname(new URL(origin).hostname)) {
        throw new PreviewUsageError(
            `--url host must match <name>-${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev`
        );
    }

    return origin;
};

interface FlagDefinitions {
    valueFlags: readonly string[];
    booleanFlags: readonly string[];
}

interface ParsedFlags {
    values: Map<string, string>;
    booleans: Set<string>;
}

export const parseFlags = (
    arguments_: string[],
    definitions: FlagDefinitions
): ParsedFlags => {
    const tokens = arguments_.filter(argument => argument !== '--');
    const values = new Map<string, string>();
    const booleans = new Set<string>();

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] as string;

        if (!token.startsWith('--')) {
            throw new PreviewUsageError('Unexpected positional argument');
        }

        const separatorIndex = token.indexOf('=');
        const name =
            separatorIndex === -1 ? token : token.slice(0, separatorIndex);
        const inlineValue =
            separatorIndex === -1 ? undefined : token.slice(separatorIndex + 1);

        if (definitions.booleanFlags.includes(name)) {
            if (inlineValue !== undefined) {
                throw new PreviewUsageError(`${name} does not take a value`);
            }

            booleans.add(name);
        } else if (definitions.valueFlags.includes(name)) {
            let value = inlineValue;

            if (value === undefined) {
                index += 1;
                value = tokens[index];
            }

            if (value === undefined || value.startsWith('--')) {
                throw new PreviewUsageError(`${name} requires a value`);
            }

            values.set(name, value);
        } else {
            throw new PreviewUsageError(`Unknown option ${name}`);
        }
    }

    return { values, booleans };
};

const parseDropPendingUpdatesValue = (values: Map<string, string>) => {
    const value = values.get('--drop-pending-updates');

    return value === undefined
        ? true
        : parseBooleanValue(value, '--drop-pending-updates');
};

const parsePollingValues = (values: Map<string, string>) => {
    const readSeconds = (flag: string, fallback: number) => {
        return parseSeconds(values.get(flag) ?? String(fallback), flag);
    };

    return {
        timeoutMilliseconds: readSeconds(
            '--timeout-seconds',
            DEFAULT_TIMEOUT_SECONDS
        ),
        readyTimeoutMilliseconds: readSeconds(
            '--ready-timeout-seconds',
            DEFAULT_READY_TIMEOUT_SECONDS
        ),
        intervalMilliseconds: readSeconds(
            '--interval-seconds',
            DEFAULT_INTERVAL_SECONDS
        )
    };
};

export const parseUrlArguments = (arguments_: string[]) => {
    const { values } = parseFlags(arguments_, {
        valueFlags: ['--branch'],
        booleanFlags: []
    });
    const branch = values.get('--branch');

    if (branch !== undefined && branch.trim() === '') {
        throw new PreviewUsageError('--branch requires a value');
    }

    return { branch };
};

export const parseWaitArguments = (arguments_: string[]) => {
    const { values } = parseFlags(arguments_, {
        valueFlags: [
            '--timeout-seconds',
            '--ready-timeout-seconds',
            '--interval-seconds'
        ],
        booleanFlags: []
    });

    return parsePollingValues(values);
};

export const parsePointArguments = (arguments_: string[]) => {
    const { values, booleans } = parseFlags(arguments_, {
        valueFlags: [
            '--drop-pending-updates',
            '--timeout-seconds',
            '--ready-timeout-seconds',
            '--interval-seconds'
        ],
        booleanFlags: ['--no-wait']
    });

    return {
        dropPendingUpdates: parseDropPendingUpdatesValue(values),
        noWait: booleans.has('--no-wait'),
        ...parsePollingValues(values)
    };
};

export const parseSmokeArguments = (arguments_: string[]) => {
    const { values } = parseFlags(arguments_, {
        valueFlags: ['--chat-id', '--user-id', '--url'],
        booleanFlags: []
    });
    const baseUrlValue = values.get('--url');

    return {
        chatId: parseChatId(values.get('--chat-id')),
        userId: parseUserId(values.get('--user-id')),
        baseUrl:
            baseUrlValue === undefined
                ? undefined
                : parseSmokeOrigin(baseUrlValue)
    };
};

export const parseResetArguments = (arguments_: string[]) => {
    const { values } = parseFlags(arguments_, {
        valueFlags: ['--drop-pending-updates'],
        booleanFlags: []
    });

    return { dropPendingUpdates: parseDropPendingUpdatesValue(values) };
};

const writeEvent = (
    dependencies: PreviewDependencies,
    event: Record<string, unknown>
) => {
    dependencies.write(JSON.stringify(event));
};

const runGitText = async (
    dependencies: PreviewDependencies,
    args: string[]
) => {
    return (await dependencies.runCommand('git', args)).trim();
};

export const readCurrentBranch = async (dependencies: PreviewDependencies) => {
    let branch: string;

    try {
        branch = await runGitText(dependencies, ['branch', '--show-current']);
    } catch {
        throw new PreviewOperatorError(
            'Could not read the current git branch; use preview:url --branch <name>'
        );
    }

    if (branch === '') {
        throw new PreviewOperatorError(
            'HEAD is detached; check out a branch first (or use preview:url --branch <name>)'
        );
    }

    return branch;
};

export const requirePushedHead = async (dependencies: PreviewDependencies) => {
    const headSha = await runGitText(dependencies, ['rev-parse', 'HEAD']);
    let upstreamSha: string;

    try {
        upstreamSha = await runGitText(dependencies, ['rev-parse', '@{u}']);
    } catch {
        throw new PreviewOperatorError(
            'The current branch has no upstream. Push it first with "git push -u origin HEAD".'
        );
    }

    if (upstreamSha !== headSha) {
        throw new PreviewOperatorError(
            'HEAD is not pushed. Push the branch, then run the command again.'
        );
    }

    return headSha;
};

const runGitHub = async (
    dependencies: PreviewDependencies,
    args: string[]
): Promise<unknown> => {
    let output: string;

    try {
        output = await dependencies.runCommand('gh', args);
    } catch {
        throw new PreviewOperatorError(
            'Could not query GitHub with gh. Check "gh auth status" and that the commit is pushed.'
        );
    }

    try {
        return JSON.parse(output) as unknown;
    } catch {
        throw new PreviewOperatorError('gh returned invalid JSON');
    }
};

const readGitHubJson = (
    dependencies: PreviewDependencies,
    endpoint: string
) => {
    return runGitHub(dependencies, ['api', endpoint]);
};

const readGitHubPages = async (
    dependencies: PreviewDependencies,
    endpoint: string
) => {
    const pages = await runGitHub(dependencies, [
        'api',
        '--paginate',
        '--slurp',
        endpoint
    ]);

    return Array.isArray(pages) ? (pages as unknown[]).flat() : [];
};

const parseCheckRuns = (payload: unknown): CheckRun[] => {
    const entries =
        isRecord(payload) && Array.isArray(payload.check_runs)
            ? (payload.check_runs as unknown[])
            : [];
    const checkRuns: CheckRun[] = [];

    for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.name !== 'string') {
            continue;
        }

        checkRuns.push({
            name: entry.name,
            status: readString(entry.status) ?? 'unknown',
            conclusion: readString(entry.conclusion)
        });
    }

    return checkRuns;
};

const parseCommitStatuses = (payload: unknown): CommitStatus[] => {
    const entries =
        isRecord(payload) && Array.isArray(payload.statuses)
            ? (payload.statuses as unknown[])
            : [];
    const statuses: CommitStatus[] = [];

    for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.context !== 'string') {
            continue;
        }

        statuses.push({
            context: entry.context,
            state: readString(entry.state) ?? 'unknown'
        });
    }

    return statuses;
};

export const fetchCommitChecks = async (
    dependencies: PreviewDependencies,
    sha: string
): Promise<CommitChecks> => {
    const commitEndpoint = `repos/{owner}/{repo}/commits/${sha}`;
    const [checkRunsPayload, statusPayload] = await Promise.all([
        readGitHubJson(
            dependencies,
            `${commitEndpoint}/check-runs?per_page=${GH_PAGE_SIZE}`
        ),
        readGitHubJson(
            dependencies,
            `${commitEndpoint}/status?per_page=${GH_PAGE_SIZE}`
        )
    ]);

    return {
        checkRuns: parseCheckRuns(checkRunsPayload),
        statuses: parseCommitStatuses(statusPayload)
    };
};

const classifyCheckRun = (checkRun: CheckRun): BuildEvaluation => {
    if (checkRun.status !== 'completed') {
        return { state: 'pending', outcome: null };
    }

    return checkRun.conclusion === 'success'
        ? { state: 'success', outcome: 'success' }
        : { state: 'failed', outcome: checkRun.conclusion };
};

const classifyCommitStatus = (status: CommitStatus): BuildEvaluation => {
    if (status.state === 'pending') {
        return { state: 'pending', outcome: null };
    }

    return status.state === 'success'
        ? { state: 'success', outcome: 'success' }
        : { state: 'failed', outcome: status.state };
};

export const evaluateBuild = (checks: CommitChecks): BuildEvaluation => {
    const evaluations = [
        ...checks.checkRuns
            .filter(checkRun => {
                return buildCheckNamePattern.test(checkRun.name);
            })
            .map(classifyCheckRun),
        ...checks.statuses
            .filter(status => {
                return buildCheckNamePattern.test(status.context);
            })
            .map(classifyCommitStatus)
    ];

    if (evaluations.length === 0) {
        return { state: 'missing', outcome: null };
    }

    const failed = evaluations.find(evaluation => {
        return evaluation.state === 'failed';
    });

    if (failed) {
        return failed;
    }

    const pending = evaluations.find(evaluation => {
        return evaluation.state === 'pending';
    });

    return pending ?? { state: 'success', outcome: 'success' };
};

const describeOutcome = (outcome: string | null) => {
    return outcome !== null && /^[a-z_]+$/.test(outcome)
        ? `"${outcome}"`
        : 'an unsuccessful result';
};

type BuildObservation =
    | { kind: 'checked'; evaluation: BuildEvaluation }
    | { kind: 'unavailable'; error: PreviewOperatorError };

const observeBuild = async (
    dependencies: PreviewDependencies,
    sha: string
): Promise<BuildObservation> => {
    try {
        const checks = await fetchCommitChecks(dependencies, sha);

        return { kind: 'checked', evaluation: evaluateBuild(checks) };
    } catch (error) {
        if (error instanceof PreviewOperatorError) {
            return { kind: 'unavailable', error };
        }

        throw error;
    }
};

const sleepUntilNextPoll = (
    dependencies: PreviewDependencies,
    polling: PollingOptions
) => {
    const remaining = Math.max(polling.deadline - dependencies.now(), 0);

    return dependencies.sleep(
        Math.min(polling.intervalMilliseconds, remaining)
    );
};

const describeBuildTimeout = (state: string) => {
    if (state === 'missing') {
        return 'Timed out: no Workers Builds check appeared for this commit';
    }

    if (state === 'unavailable') {
        return 'Timed out: gh could not read the Workers Builds check';
    }

    return 'Timed out waiting for Workers Builds to finish';
};

export const waitForBuild = async (
    dependencies: PreviewDependencies,
    sha: string,
    polling: PollingOptions
) => {
    let lastReportedState: string | undefined;
    let consecutiveFailures = 0;

    while (true) {
        const observation = await observeBuild(dependencies, sha);
        const reportedState =
            observation.kind === 'checked'
                ? observation.evaluation.state
                : 'unavailable';

        consecutiveFailures =
            observation.kind === 'checked' ? 0 : consecutiveFailures + 1;

        if (reportedState !== lastReportedState) {
            writeEvent(dependencies, {
                event: 'preview_build_status',
                state: reportedState
            });
            lastReportedState = reportedState;
        }

        if (observation.kind === 'checked') {
            const { evaluation } = observation;

            if (evaluation.state === 'success') {
                return;
            }

            if (evaluation.state === 'failed') {
                throw new PreviewOperatorError(
                    `Workers Builds finished with ${describeOutcome(evaluation.outcome)}`
                );
            }
        } else if (
            consecutiveFailures >= MAX_CONSECUTIVE_BUILD_LOOKUP_FAILURES
        ) {
            throw observation.error;
        }

        if (dependencies.now() >= polling.deadline) {
            throw new PreviewOperatorError(describeBuildTimeout(reportedState));
        }

        await sleepUntilNextPoll(dependencies, polling);
    }
};

const isBuildsBotComment = (
    comment: unknown
): comment is Record<string, unknown> => {
    return (
        isRecord(comment) &&
        isRecord(comment.user) &&
        comment.user.login === BUILDS_BOT_LOGIN &&
        comment.user.type === BUILDS_BOT_TYPE
    );
};

export const findOriginInBotComments = async (
    dependencies: PreviewDependencies,
    sha: string,
    branch: string
) => {
    try {
        const pullRequests = await readGitHubJson(
            dependencies,
            `repos/{owner}/{repo}/commits/${sha}/pulls?per_page=${GH_PAGE_SIZE}`
        );

        const branchPullRequests = (
            Array.isArray(pullRequests) ? (pullRequests as unknown[]) : []
        )
            .filter(pullRequest => {
                return (
                    isRecord(pullRequest) &&
                    isRecord(pullRequest.head) &&
                    pullRequest.head.ref === branch &&
                    Number.isSafeInteger(pullRequest.number)
                );
            })
            .slice(0, MAX_PULL_REQUESTS_INSPECTED);

        for (const pullRequest of branchPullRequests as Record<
            string,
            unknown
        >[]) {
            const comments = await readGitHubPages(
                dependencies,
                `repos/{owner}/{repo}/issues/${pullRequest.number}/comments?per_page=${GH_PAGE_SIZE}`
            );

            for (const comment of comments.reverse()) {
                const origin = isBuildsBotComment(comment)
                    ? parsePreviewUrlHeader(readString(comment.body))
                    : undefined;

                if (origin !== undefined) {
                    return origin;
                }
            }
        }
    } catch (error) {
        if (!(error instanceof PreviewOperatorError)) {
            throw error;
        }
    }

    return undefined;
};

export const resolvePreviewOrigin = async (
    dependencies: PreviewDependencies,
    options: { branch?: string | undefined }
) => {
    if (options.branch !== undefined) {
        return createPreviewOrigin(options.branch);
    }

    const branch = await readCurrentBranch(dependencies);

    try {
        return createPreviewOrigin(branch);
    } catch (error) {
        if (!(error instanceof PreviewLabelTooLongError)) {
            throw error;
        }

        const headSha = await runGitText(dependencies, ['rev-parse', 'HEAD']);
        const commentOrigin = await findOriginInBotComments(
            dependencies,
            headSha,
            branch
        );

        if (commentOrigin === undefined) {
            throw error;
        }

        return commentOrigin;
    }
};

interface JsonResponse {
    status: number;
    body: unknown;
}

const readBoundedText = async (response: Response, maximumBytes: number) => {
    const declaredLength = Number(response.headers.get('content-length'));

    if (declaredLength > maximumBytes) {
        await response.body?.cancel().catch(() => undefined);

        return undefined;
    }

    if (!response.body) {
        return '';
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let byteLength = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            byteLength += value.byteLength;

            if (byteLength > maximumBytes) {
                await reader.cancel().catch(() => undefined);

                return undefined;
            }

            text += decoder.decode(value, { stream: true });
        }
    } finally {
        reader.releaseLock();
    }

    return text + decoder.decode();
};

const requestJson = async (
    dependencies: PreviewDependencies,
    url: string,
    headers: Record<string, string>
): Promise<JsonResponse | undefined> => {
    try {
        const response = await dependencies.fetchImplementation(url, {
            method: 'GET',
            headers,
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)
        });
        const text = await readBoundedText(response, MAX_READINESS_BODY_BYTES);
        let body: unknown;

        try {
            body = text === undefined ? undefined : JSON.parse(text);
        } catch {
            body = undefined;
        }

        return { status: response.status, body };
    } catch {
        return undefined;
    }
};

export interface ReadinessResult {
    rootReady: boolean;
    healthReady: boolean;
    healthStatus: number | null;
}

export const checkPreviewReadiness = async (
    dependencies: PreviewDependencies,
    origin: string,
    secret: string
): Promise<ReadinessResult> => {
    const root = await requestJson(dependencies, `${origin}/`, {});
    const rootReady =
        root !== undefined &&
        root.status === 200 &&
        isRecord(root.body) &&
        root.body.service === WORKER_NAME;

    if (!rootReady) {
        return { rootReady, healthReady: false, healthStatus: null };
    }

    const health = await requestJson(dependencies, `${origin}/health`, {
        [TELEGRAM_SECRET_HEADER]: secret
    });
    const healthReady =
        health !== undefined &&
        health.status === 200 &&
        isRecord(health.body) &&
        health.body.ready === true;

    return {
        rootReady,
        healthReady,
        healthStatus: health === undefined ? null : health.status
    };
};

export const waitForReadiness = async (
    dependencies: PreviewDependencies,
    origin: string,
    secret: string,
    polling: PollingOptions
) => {
    let lastSummary = '';

    while (true) {
        const result = await checkPreviewReadiness(
            dependencies,
            origin,
            secret
        );
        const summary = `${result.rootReady}:${result.healthReady}:${result.healthStatus}`;

        if (summary !== lastSummary) {
            writeEvent(dependencies, {
                event: 'preview_readiness',
                rootReady: result.rootReady,
                healthReady: result.healthReady,
                healthStatus: result.healthStatus
            });
            lastSummary = summary;
        }

        if (result.rootReady && result.healthReady) {
            return;
        }

        if (dependencies.now() >= polling.deadline) {
            throw new PreviewOperatorError(
                `Timed out waiting for the preview to become ready (root ok: ${result.rootReady}, last /health status: ${result.healthStatus ?? 'no response'}). Check the URL in the Workers Builds pull request comment and, if it differs, run pnpm telegram:webhook:set:preview --url <url> manually.`
            );
        }

        await sleepUntilNextPoll(dependencies, polling);
    }
};

const requireWebhookSecret = () => {
    return requireEnv('TELEGRAM_WEBHOOK_SECRET');
};

export const requirePreviewBot = (dependencies: PreviewDependencies) => {
    return requirePreviewBotIdentity(() => {
        return callTelegramApi('getMe', undefined, dependencies.telegram);
    });
};

export interface WaitOptions {
    timeoutMilliseconds: number;
    readyTimeoutMilliseconds: number;
    intervalMilliseconds: number;
}

export const waitForPreview = async (
    dependencies: PreviewDependencies,
    options: WaitOptions
) => {
    const secret = requireWebhookSecret();
    const headSha = await requirePushedHead(dependencies);
    const origin = await resolvePreviewOrigin(dependencies, {});

    writeEvent(dependencies, { event: 'preview_url_resolved', origin });

    await waitForBuild(dependencies, headSha, {
        deadline: dependencies.now() + options.timeoutMilliseconds,
        intervalMilliseconds: options.intervalMilliseconds
    });
    await waitForReadiness(dependencies, origin, secret, {
        deadline: dependencies.now() + options.readyTimeoutMilliseconds,
        intervalMilliseconds: options.intervalMilliseconds
    });
    writeEvent(dependencies, { event: 'preview_ready', origin });

    return origin;
};

const verifyWebhookTarget = (
    dependencies: PreviewDependencies,
    payload: TelegramApiPayload,
    expectedWebhookUrl: string
) => {
    dependencies.write(formatTelegramWebhookInfo(payload, expectedWebhookUrl));

    if (
        !summarizeTelegramWebhookInfo(payload, expectedWebhookUrl)
            .urlMatchesExpected
    ) {
        throw new PreviewOperatorError(
            'Telegram reports a webhook URL that differs from the requested preview'
        );
    }
};

export const pointPreviewWebhook = async (
    dependencies: PreviewDependencies,
    options: WaitOptions & {
        dropPendingUpdates: boolean;
        noWait: boolean;
    }
) => {
    await requirePreviewBot(dependencies);

    const origin = options.noWait
        ? await resolvePreviewOrigin(dependencies, {})
        : await waitForPreview(dependencies, options);
    const expectedWebhookUrl = createWebhookUrl(origin);
    const currentPayload = await readWebhookInfo(dependencies.telegram);
    const previousOrigin = readConfiguredWebhookOrigin(currentPayload);
    const alreadyPointedAtTarget = summarizeTelegramWebhookInfo(
        currentPayload,
        expectedWebhookUrl
    ).urlMatchesExpected;

    writeEvent(dependencies, {
        event: 'preview_webhook_current',
        alreadyPointedAtTarget,
        ...(previousOrigin !== null && previousOrigin !== origin
            ? { previousOrigin }
            : {})
    });

    await setTelegramWebhook(
        origin,
        options.dropPendingUpdates,
        dependencies.telegram
    );

    const updatedPayload = await readWebhookInfo(dependencies.telegram);

    verifyWebhookTarget(dependencies, updatedPayload, expectedWebhookUrl);

    return origin;
};

export const resetPreviewWebhook = async (
    dependencies: PreviewDependencies,
    options: { dropPendingUpdates: boolean }
) => {
    await requirePreviewBot(dependencies);

    const expectedWebhookUrl = createWebhookUrl(LONG_LIVED_PREVIEW_ORIGIN);

    await setTelegramWebhook(
        LONG_LIVED_PREVIEW_ORIGIN,
        options.dropPendingUpdates,
        dependencies.telegram
    );

    const payload = await readWebhookInfo(dependencies.telegram);

    verifyWebhookTarget(dependencies, payload, expectedWebhookUrl);
};

export const getSyntheticChatType = (chatId: number) => {
    return chatId < 0 ? 'supergroup' : 'private';
};

export const createSyntheticStartUpdate = (
    chatId: number,
    nowMilliseconds: number,
    userId?: number
) => {
    const chatType = getSyntheticChatType(chatId);
    const senderId =
        userId ?? (chatType === 'private' ? chatId : SYNTHETIC_GROUP_SENDER_ID);
    const chat =
        chatType === 'private'
            ? {
                  id: chatId,
                  type: chatType,
                  first_name: SYNTHETIC_PRIVATE_CHAT_NAME
              }
            : {
                  id: chatId,
                  type: chatType,
                  title: SYNTHETIC_PRIVATE_CHAT_NAME
              };

    return {
        update_id: nowMilliseconds,
        message: {
            message_id: SYNTHETIC_MESSAGE_ID,
            date: Math.floor(nowMilliseconds / 1000),
            chat,
            from: {
                id: senderId,
                is_bot: false,
                first_name: SYNTHETIC_PRIVATE_CHAT_NAME,
                language_code: 'en'
            },
            text: SMOKE_COMMAND_TEXT,
            entities: [
                {
                    offset: 0,
                    length: SMOKE_COMMAND_TEXT.length,
                    type: 'bot_command'
                }
            ]
        }
    };
};

export const sendSmokeUpdate = async (
    dependencies: PreviewDependencies,
    options: {
        chatId: number;
        userId: number | undefined;
        baseUrl: string | undefined;
    }
) => {
    const origin =
        options.baseUrl ?? (await resolvePreviewOrigin(dependencies, {}));
    const secret = requireWebhookSecret();
    const update = createSyntheticStartUpdate(
        options.chatId,
        dependencies.now(),
        options.userId
    );
    const webhookUrl = createWebhookUrl(origin);

    writeEvent(dependencies, {
        event: 'preview_smoke_sending',
        origin,
        chatId: options.chatId
    });

    const response = await dependencies.fetchImplementation(webhookUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            [TELEGRAM_SECRET_HEADER]: secret
        },
        body: JSON.stringify(update),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)
    });

    await response.body?.cancel().catch(() => undefined);

    if (response.status !== 200) {
        throw new PreviewOperatorError(
            `The preview rejected the synthetic update with HTTP ${response.status}`
        );
    }

    writeEvent(dependencies, {
        event: 'preview_smoke_accepted',
        status: response.status
    });
};

export const runPreviewCommand = async (
    subcommand: string | undefined,
    arguments_: string[],
    dependencies: PreviewDependencies
) => {
    switch (subcommand) {
        case 'url': {
            const { branch } = parseUrlArguments(arguments_);

            dependencies.write(
                await resolvePreviewOrigin(dependencies, { branch })
            );
            return;
        }
        case 'wait': {
            await waitForPreview(dependencies, parseWaitArguments(arguments_));
            return;
        }
        case 'point': {
            await pointPreviewWebhook(
                dependencies,
                parsePointArguments(arguments_)
            );
            return;
        }
        case 'smoke': {
            await sendSmokeUpdate(
                dependencies,
                parseSmokeArguments(arguments_)
            );
            return;
        }
        case 'reset': {
            await resetPreviewWebhook(
                dependencies,
                parseResetArguments(arguments_)
            );
            return;
        }
        case 'help':
        case '--help':
        case '-h': {
            dependencies.write(USAGE);
            return;
        }
        default: {
            throw new PreviewUsageError(
                subcommand === undefined
                    ? 'Missing subcommand'
                    : 'Unknown subcommand'
            );
        }
    }
};

const readTelegramFailureMessage = (error: Error) => {
    const description = telegramFailureMessagePattern.exec(error.message)?.[1];

    return description !== undefined &&
        safeTelegramDescriptionPattern.test(description) &&
        !/http/i.test(description)
        ? error.message
        : null;
};

const readExposedMessage = (error: unknown) => {
    if (error instanceof PreviewOperatorError) {
        return error.message;
    }

    if (!(error instanceof Error)) {
        return null;
    }

    return missingEnvironmentMessagePattern.test(error.message)
        ? error.message
        : readTelegramFailureMessage(error);
};

export const createFailureEvent = (error: unknown) => {
    const message = readExposedMessage(error);

    return {
        event: 'preview_command_failed',
        errorType: error instanceof Error ? error.name : typeof error,
        ...(message === null ? {} : { message })
    };
};

export const createDefaultDependencies = (): PreviewDependencies => {
    return {
        runCommand: runLocalCommand,
        fetchImplementation: fetch,
        now: Date.now,
        sleep: milliseconds => {
            return new Promise<void>(resolve => {
                setTimeout(resolve, milliseconds);
            });
        },
        write: line => {
            console.log(line);
        },
        telegram: {}
    };
};

const run = async () => {
    const [subcommand, ...arguments_] = process.argv.slice(2);

    if (
        subcommand !== undefined &&
        PREVIEW_ENVIRONMENT_COMMANDS.includes(subcommand)
    ) {
        await loadPreviewEnvironment({ runCommand: runLocalCommand });
    }

    await runPreviewCommand(
        subcommand,
        arguments_,
        createDefaultDependencies()
    );
};

const scriptPath = process.argv[1];

if (
    scriptPath &&
    import.meta.url === pathToFileURL(path.resolve(scriptPath)).href
) {
    void run().catch((error: unknown) => {
        console.error(JSON.stringify(createFailureEvent(error)));

        if (error instanceof PreviewUsageError) {
            console.error(USAGE);
        }

        process.exitCode = 1;
    });
}
