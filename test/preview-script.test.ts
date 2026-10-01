import assert from 'node:assert/strict';
import test from 'node:test';

import {
    checkPreviewReadiness,
    createBranchSlug,
    createFailureEvent,
    createPreviewOrigin,
    createSyntheticStartUpdate,
    evaluateBuild,
    findOriginInBotComments,
    LONG_LIVED_PREVIEW_ORIGIN,
    loadPreviewEnvironment,
    parseChatId,
    parseFlags,
    parsePointArguments,
    parsePreviewUrlHeader,
    parseSmokeArguments,
    parseUrlArguments,
    parseUserId,
    parseWaitArguments,
    PreviewLabelTooLongError,
    PreviewOperatorError,
    PreviewUsageError,
    requirePushedHead,
    resolvePreviewOrigin,
    runPreviewCommand,
    waitForBuild,
    waitForPreview,
    waitForReadiness,
    type CommitChecks,
    type PreviewDependencies
} from '../scripts/telegram/preview';

const secretToken = 'preview-secret-value';
const webhookPath = '/telegram/hidden-preview-path';
const botToken = '123456:preview-bot-token';
const headSha = 'a'.repeat(40);
const previewOrigin = 'https://feat-demo-princess.chernenko.workers.dev';
const otherOrigin = 'https://other-branch-princess.chernenko.workers.dev';
const longBranch = `feature/${'x'.repeat(60)}`;
const botLogin = 'cloudflare-workers-and-pages[bot]';

const asFetch = (
    implementation: (
        input: RequestInfo | URL,
        init?: RequestInit
    ) => Promise<Response>
) => {
    return implementation as typeof fetch;
};

const createClock = () => {
    let current = 1_000_000;

    return {
        now: () => current,
        sleep: async (milliseconds: number) => {
            current += milliseconds;
        }
    };
};

type CommandResponse = string | Error | (() => string | Error);

const createRunCommand = (responses: Record<string, CommandResponse>) => {
    return async (command: string, args: string[]) => {
        const key = `${command} ${args.join(' ')}`;
        const handler = responses[key];

        if (handler === undefined) {
            throw new Error(`Unexpected command: ${key}`);
        }

        const response = typeof handler === 'function' ? handler() : handler;

        if (response instanceof Error) {
            throw response;
        }

        return response;
    };
};

const createDependencies = (
    overrides: Partial<PreviewDependencies> = {}
): { dependencies: PreviewDependencies; output: string[] } => {
    const output: string[] = [];
    const clock = createClock();
    const dependencies: PreviewDependencies = {
        runCommand: createRunCommand({}),
        fetchImplementation: asFetch(async () => {
            throw new Error('Unexpected fetch');
        }),
        now: clock.now,
        sleep: clock.sleep,
        write: line => {
            output.push(line);
        },
        telegram: {},
        ...overrides
    };

    return { dependencies, output };
};

const withPreviewEnvironment = async (
    action: (captured: string[]) => Promise<void>
) => {
    const previous = {
        BOT_TOKEN: process.env.BOT_TOKEN,
        TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
        TELEGRAM_WEBHOOK_PATH: process.env.TELEGRAM_WEBHOOK_PATH
    };
    const originalLog = console.log;
    const captured: string[] = [];

    process.env.BOT_TOKEN = botToken;
    process.env.TELEGRAM_WEBHOOK_SECRET = secretToken;
    process.env.TELEGRAM_WEBHOOK_PATH = webhookPath;
    console.log = (...values: unknown[]) => {
        captured.push(values.map(String).join(' '));
    };

    try {
        await action(captured);
    } finally {
        console.log = originalLog;

        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) {
                Reflect.deleteProperty(process.env, name);
            } else {
                process.env[name] = value;
            }
        }
    }
};

const assertNoSensitiveValues = (lines: string[]) => {
    const everything = lines.join('\n');

    assert.equal(everything.includes(secretToken), false);
    assert.equal(everything.includes(webhookPath), false);
    assert.equal(everything.includes('hidden-preview-path'), false);
    assert.equal(everything.includes(botToken), false);
};

const checkRun = (
    overrides: Partial<{
        name: string;
        status: string;
        conclusion: string | null;
    }> = {}
) => {
    return {
        name: 'Workers Builds: princess',
        status: 'completed',
        conclusion: 'success',
        ...overrides
    };
};

const checkRunsJson = (...runs: ReturnType<typeof checkRun>[]) => {
    return JSON.stringify({ total_count: runs.length, check_runs: runs });
};

const statusJson = (...statuses: { context: string; state: string }[]) => {
    return JSON.stringify({ state: 'pending', statuses });
};

const checkRunsEndpoint = `gh api repos/{owner}/{repo}/commits/${headSha}/check-runs?per_page=100`;
const statusEndpoint = `gh api repos/{owner}/{repo}/commits/${headSha}/status?per_page=100`;
const pullsEndpoint = `gh api repos/{owner}/{repo}/commits/${headSha}/pulls?per_page=100`;
const commentsEndpoint =
    'gh api --paginate --slurp repos/{owner}/{repo}/issues/7/comments?per_page=100';
const currentBranchCommand = 'git branch --show-current';

const botComment = (body: string, overrides: Record<string, unknown> = {}) => {
    return {
        body,
        user: { login: botLogin, type: 'Bot' },
        ...overrides
    };
};

test('branch slugs are lowercased and non-alphanumerics become dashes', () => {
    assert.equal(
        createBranchSlug('Feat/Webhook_Preview.URL'),
        'feat-webhook-preview-url'
    );
    assert.equal(
        createPreviewOrigin('feat/webhook-preview-url'),
        'https://feat-webhook-preview-url-princess.chernenko.workers.dev'
    );
    assert.equal(
        createPreviewOrigin('FIX/API'),
        'https://fix-api-princess.chernenko.workers.dev'
    );
});

test('branch slugs accept the longest label and reject longer ones', () => {
    const longestSlug = 'a'.repeat(63 - '-princess'.length);

    assert.equal(
        createPreviewOrigin(longestSlug),
        `https://${longestSlug}-princess.chernenko.workers.dev`
    );
    assert.throws(
        () => createPreviewOrigin(`${longestSlug}b`),
        error => {
            return (
                error instanceof PreviewLabelTooLongError &&
                error.message.includes('64 characters') &&
                error.message.includes('63-character')
            );
        }
    );
});

test('branch slugs must start with a letter', () => {
    assert.throws(() => createBranchSlug('123-fix'), PreviewOperatorError);
    assert.throws(() => createBranchSlug('/leading'), PreviewOperatorError);
});

test('the preview header is parsed from the branch alias line only', () => {
    const body = [
        '## Deploying princess with Workers Builds',
        '',
        `### Preview URL: ${previewOrigin}`,
        '',
        '| Commit | Preview URL |',
        '| --- | --- |',
        '| abc12345 | https://abc12345-princess.chernenko.workers.dev |'
    ].join('\n');

    assert.equal(parsePreviewUrlHeader(body), previewOrigin);
    assert.equal(
        parsePreviewUrlHeader(`### Preview URL: [open](${previewOrigin})`),
        previewOrigin
    );
});

test('the preview header parser ignores the deployment table and missing headers', () => {
    assert.equal(
        parsePreviewUrlHeader(
            '| abc12345 | https://abc12345-princess.chernenko.workers.dev |'
        ),
        undefined
    );
    assert.equal(
        parsePreviewUrlHeader(`Preview is at ${previewOrigin}`),
        undefined
    );
    assert.equal(parsePreviewUrlHeader('### Preview URL:'), undefined);
    assert.equal(parsePreviewUrlHeader(null), undefined);
});

test('the preview header parser rejects commit hash hosts and foreign hosts', () => {
    for (const url of [
        'https://abc12345-princess.chernenko.workers.dev',
        'https://0123abcd-princess.chernenko.workers.dev',
        'https://evil.workers.dev',
        'https://x-princess.attacker.workers.dev',
        'https://x-princess.chernenko.workers.dev.evil.example',
        'https://princess.chernenko.workers.dev',
        'http://x-princess.chernenko.workers.dev',
        'https://dash.cloudflare.com/princess'
    ]) {
        assert.equal(
            parsePreviewUrlHeader(`### Preview URL: ${url}`),
            undefined
        );
    }

    assert.equal(
        parsePreviewUrlHeader(
            '### Preview URL: https://abc12345x-princess.chernenko.workers.dev'
        ),
        'https://abc12345x-princess.chernenko.workers.dev'
    );
});

test('build evaluation covers pending, success, failure and missing checks', () => {
    const evaluate = (
        runs: ReturnType<typeof checkRun>[],
        statuses: { context: string; state: string }[] = []
    ) => {
        const checks: CommitChecks = { checkRuns: runs, statuses };

        return evaluateBuild(checks);
    };

    assert.equal(evaluate([]).state, 'missing');
    assert.equal(
        evaluate([checkRun({ name: 'validate', conclusion: 'failure' })]).state,
        'missing'
    );
    assert.equal(
        evaluate([checkRun({ status: 'in_progress', conclusion: null })]).state,
        'pending'
    );
    assert.equal(evaluate([checkRun()]).state, 'success');
    assert.deepEqual(evaluate([checkRun({ conclusion: 'cancelled' })]), {
        state: 'failed',
        outcome: 'cancelled'
    });
    assert.equal(
        evaluate(
            [],
            [{ context: 'Workers Builds: princess', state: 'pending' }]
        ).state,
        'pending'
    );
    assert.equal(
        evaluate([], [{ context: 'Workers Builds: princess', state: 'error' }])
            .state,
        'failed'
    );
    assert.equal(
        evaluate(
            [checkRun()],
            [{ context: 'workers builds: other', state: 'failure' }]
        ).state,
        'failed'
    );
});

test('waiting for the build goes from pending to success', async () => {
    const responses = [
        checkRunsJson(),
        checkRunsJson(checkRun({ status: 'in_progress', conclusion: null })),
        checkRunsJson(checkRun())
    ];
    let checkRunCalls = 0;
    const { dependencies, output } = createDependencies({
        runCommand: createRunCommand({
            [checkRunsEndpoint]: () => {
                const response = responses[checkRunCalls] as string;
                checkRunCalls += 1;
                return response;
            },
            [statusEndpoint]: statusJson()
        })
    });

    await waitForBuild(dependencies, headSha, {
        deadline: dependencies.now() + 60_000,
        intervalMilliseconds: 10_000
    });

    assert.equal(checkRunCalls, 3);
    assert.deepEqual(
        output.map(line => JSON.parse(line).state),
        ['missing', 'pending', 'success']
    );
});

test('waiting for the build fails on a failed or cancelled check', async () => {
    const { dependencies } = createDependencies({
        runCommand: createRunCommand({
            [checkRunsEndpoint]: checkRunsJson(
                checkRun({ conclusion: 'cancelled' })
            ),
            [statusEndpoint]: statusJson()
        })
    });

    await assert.rejects(
        waitForBuild(dependencies, headSha, {
            deadline: dependencies.now() + 60_000,
            intervalMilliseconds: 10_000
        }),
        /Workers Builds finished with "cancelled"/
    );
});

test('waiting for the build times out while pending or missing', async () => {
    const pending = createDependencies({
        runCommand: createRunCommand({
            [checkRunsEndpoint]: checkRunsJson(
                checkRun({ status: 'queued', conclusion: null })
            ),
            [statusEndpoint]: statusJson()
        })
    });
    const missing = createDependencies({
        runCommand: createRunCommand({
            [checkRunsEndpoint]: checkRunsJson(),
            [statusEndpoint]: statusJson()
        })
    });
    const startedAt = pending.dependencies.now();

    await assert.rejects(
        waitForBuild(pending.dependencies, headSha, {
            deadline: startedAt + 30_000,
            intervalMilliseconds: 10_000
        }),
        /Timed out waiting for Workers Builds to finish/
    );
    assert.equal(pending.dependencies.now() - startedAt, 30_000);
    await assert.rejects(
        waitForBuild(missing.dependencies, headSha, {
            deadline: missing.dependencies.now() + 20_000,
            intervalMilliseconds: 10_000
        }),
        /no Workers Builds check appeared/
    );
});

test('a transient gh failure keeps the build wait going', async () => {
    let calls = 0;
    const { dependencies, output } = createDependencies({
        runCommand: createRunCommand({
            [checkRunsEndpoint]: () => {
                calls += 1;

                return calls <= 2
                    ? new Error('gh: HTTP 502')
                    : checkRunsJson(checkRun());
            },
            [statusEndpoint]: statusJson()
        })
    });

    await waitForBuild(dependencies, headSha, {
        deadline: dependencies.now() + 60_000,
        intervalMilliseconds: 10_000
    });

    assert.equal(calls, 3);
    assert.deepEqual(
        output.map(line => JSON.parse(line).state),
        ['unavailable', 'success']
    );
});

test('five consecutive gh failures fail the build wait without leaking gh output', async () => {
    let calls = 0;
    const { dependencies } = createDependencies({
        runCommand: createRunCommand({
            [checkRunsEndpoint]: () => {
                calls += 1;
                return new Error('gh: command not found');
            },
            [statusEndpoint]: statusJson()
        })
    });

    await assert.rejects(
        waitForBuild(dependencies, headSha, {
            deadline: dependencies.now() + 600_000,
            intervalMilliseconds: 10_000
        }),
        error => {
            return (
                error instanceof PreviewOperatorError &&
                !error.message.includes('command not found')
            );
        }
    );
    assert.equal(calls, 5);
});

test('a gh failure that outlasts the deadline times out', async () => {
    const { dependencies } = createDependencies({
        runCommand: createRunCommand({
            [checkRunsEndpoint]: new Error('gh failed'),
            [statusEndpoint]: statusJson()
        })
    });

    await assert.rejects(
        waitForBuild(dependencies, headSha, {
            deadline: dependencies.now() + 20_000,
            intervalMilliseconds: 10_000
        }),
        /Timed out: gh could not read/
    );
});

test('the preview origin is computed from the branch without GitHub', async () => {
    const { dependencies } = createDependencies({
        runCommand: createRunCommand({
            [currentBranchCommand]: 'Feat/Demo\n'
        })
    });

    assert.equal(
        await resolvePreviewOrigin(dependencies, {}),
        'https://feat-demo-princess.chernenko.workers.dev'
    );
});

test('an explicit branch skips git and GitHub lookups', async () => {
    const { dependencies } = createDependencies();

    assert.equal(
        await resolvePreviewOrigin(dependencies, { branch: 'feat/demo' }),
        'https://feat-demo-princess.chernenko.workers.dev'
    );
});

test('a detached HEAD asks for a branch', async () => {
    const { dependencies } = createDependencies({
        runCommand: createRunCommand({ [currentBranchCommand]: '\n' })
    });

    await assert.rejects(resolvePreviewOrigin(dependencies, {}), /detached/);
});

const longBranchCommands = (
    comments: unknown[][] | Error,
    pulls: unknown = [{ number: 7, head: { ref: longBranch } }]
) => {
    return {
        [currentBranchCommand]: longBranch,
        'git rev-parse HEAD': headSha,
        [pullsEndpoint]: JSON.stringify(pulls),
        [commentsEndpoint]:
            comments instanceof Error ? comments : JSON.stringify(comments)
    };
};

test('an over-length branch falls back to the newest Workers Builds bot comment', async () => {
    const { dependencies } = createDependencies({
        runCommand: createRunCommand(
            longBranchCommands([
                [
                    botComment(`### Preview URL: ${otherOrigin}`),
                    botComment('no header here')
                ],
                [
                    botComment(`### Preview URL: ${previewOrigin}`),
                    botComment(
                        '### Preview URL: https://abc12345-princess.chernenko.workers.dev'
                    )
                ]
            ])
        )
    });

    assert.equal(await resolvePreviewOrigin(dependencies, {}), previewOrigin);
});

test('the fallback ignores comments from anyone but the Workers Builds bot', async () => {
    const hostile = `### Preview URL: ${otherOrigin}`;
    const { dependencies } = createDependencies({
        runCommand: createRunCommand(
            longBranchCommands([
                [
                    botComment(hostile, {
                        user: { login: 'someone', type: 'User' }
                    }),
                    botComment(hostile, {
                        user: { login: botLogin, type: 'User' }
                    }),
                    botComment(hostile, {
                        user: { login: 'other-app[bot]', type: 'Bot' }
                    }),
                    botComment(hostile, { user: undefined })
                ]
            ])
        )
    });

    await assert.rejects(
        resolvePreviewOrigin(dependencies, {}),
        PreviewLabelTooLongError
    );
});

test('the fallback fails with the length error when no comment has a header', async () => {
    const withoutHeader = createDependencies({
        runCommand: createRunCommand(
            longBranchCommands([[botComment('Deployed successfully')]])
        )
    });
    const withGhFailure = createDependencies({
        runCommand: createRunCommand(longBranchCommands(new Error('gh failed')))
    });
    const withoutPull = createDependencies({
        runCommand: createRunCommand(longBranchCommands([], []))
    });

    for (const { dependencies } of [
        withoutHeader,
        withGhFailure,
        withoutPull
    ]) {
        await assert.rejects(
            resolvePreviewOrigin(dependencies, {}),
            PreviewLabelTooLongError
        );
    }
});

test('the fallback ignores pull requests from other branches with the same sha', async () => {
    const otherPullEndpoint = `gh api --paginate --slurp repos/{owner}/{repo}/issues/9/comments?per_page=100`;
    const { dependencies } = createDependencies({
        runCommand: createRunCommand({
            [currentBranchCommand]: longBranch,
            'git rev-parse HEAD': headSha,
            [pullsEndpoint]: JSON.stringify([
                { number: 9, head: { ref: 'some/other-branch' } },
                { number: 8 },
                { number: 7, head: { ref: longBranch } }
            ]),
            [otherPullEndpoint]: JSON.stringify([
                [botComment(`### Preview URL: ${otherOrigin}`)]
            ]),
            [commentsEndpoint]: JSON.stringify([
                [botComment(`### Preview URL: ${previewOrigin}`)]
            ])
        })
    });

    assert.equal(await resolvePreviewOrigin(dependencies, {}), previewOrigin);

    const onlyOtherBranch = createDependencies({
        runCommand: createRunCommand(
            longBranchCommands(
                [[botComment(`### Preview URL: ${otherOrigin}`)]],
                [{ number: 7, head: { ref: 'some/other-branch' } }]
            )
        )
    });

    await assert.rejects(
        resolvePreviewOrigin(onlyOtherBranch.dependencies, {}),
        PreviewLabelTooLongError
    );
});

test('the fallback never runs for branches whose label fits or for other errors', async () => {
    const shortBranch = createDependencies({
        runCommand: createRunCommand({ [currentBranchCommand]: 'feat-demo' })
    });
    const digitBranch = createDependencies({
        runCommand: createRunCommand({ [currentBranchCommand]: '1-fix' })
    });
    const explicitLongBranch = createDependencies();

    assert.equal(
        await resolvePreviewOrigin(shortBranch.dependencies, {}),
        previewOrigin
    );
    await assert.rejects(
        resolvePreviewOrigin(digitBranch.dependencies, {}),
        error => {
            return (
                error instanceof PreviewOperatorError &&
                !(error instanceof PreviewLabelTooLongError)
            );
        }
    );
    await assert.rejects(
        resolvePreviewOrigin(explicitLongBranch.dependencies, {
            branch: longBranch
        }),
        PreviewLabelTooLongError
    );
});

test('bot comments are read across pages and checked newest first', async () => {
    const { dependencies } = createDependencies({
        runCommand: createRunCommand({
            [pullsEndpoint]: JSON.stringify([
                { number: 7, head: { ref: longBranch } }
            ]),
            [commentsEndpoint]: JSON.stringify([
                [botComment(`### Preview URL: ${otherOrigin}`)],
                [botComment(`### Preview URL: ${previewOrigin}`)]
            ])
        })
    });

    assert.equal(
        await findOriginInBotComments(dependencies, headSha, longBranch),
        previewOrigin
    );
});

test('wait requires HEAD to be pushed', async () => {
    const unpushed = createDependencies({
        runCommand: createRunCommand({
            'git rev-parse HEAD': headSha,
            'git rev-parse @{u}': 'b'.repeat(40)
        })
    });
    const noUpstream = createDependencies({
        runCommand: createRunCommand({
            'git rev-parse HEAD': headSha,
            'git rev-parse @{u}': new Error('fatal: no upstream')
        })
    });
    const pushed = createDependencies({
        runCommand: createRunCommand({
            'git rev-parse HEAD': headSha,
            'git rev-parse @{u}': `${headSha}\n`
        })
    });

    await assert.rejects(
        requirePushedHead(unpushed.dependencies),
        /HEAD is not pushed/
    );
    await assert.rejects(
        requirePushedHead(noUpstream.dependencies),
        /no upstream/
    );
    assert.equal(await requirePushedHead(pushed.dependencies), headSha);
});

interface RequestRecord {
    url: string;
    headers: HeadersInit | undefined;
}

const createReadyFetch = (requests: RequestRecord[]) => {
    return asFetch(async (input, init) => {
        const url = String(input);

        requests.push({ url, headers: init?.headers });

        if (url.endsWith('/health')) {
            return Response.json({ service: 'princess', ready: true });
        }

        return Response.json({ service: 'princess' });
    });
};

test('readiness checks root first and sends the secret only to /health', async () => {
    const requests: RequestRecord[] = [];
    let attempt = 0;
    const { dependencies, output } = createDependencies({
        fetchImplementation: asFetch(async (input, init) => {
            const url = String(input);

            requests.push({ url, headers: init?.headers });

            if (!url.endsWith('/health')) {
                attempt += 1;

                if (attempt === 1) {
                    throw new Error('connection refused');
                }

                return Response.json({ service: 'princess' });
            }

            return attempt === 2
                ? Response.json({ ready: false }, { status: 503 })
                : Response.json({ service: 'princess', ready: true });
        })
    });

    await waitForReadiness(dependencies, previewOrigin, secretToken, {
        deadline: dependencies.now() + 60_000,
        intervalMilliseconds: 5000
    });

    assert.deepEqual(
        requests.map(request => request.url),
        [
            `${previewOrigin}/`,
            `${previewOrigin}/`,
            `${previewOrigin}/health`,
            `${previewOrigin}/`,
            `${previewOrigin}/health`
        ]
    );
    for (const request of requests) {
        assert.deepEqual(
            request.headers,
            request.url.endsWith('/health')
                ? { 'X-Telegram-Bot-Api-Secret-Token': secretToken }
                : {}
        );
    }
    assertNoSensitiveValues(output);
});

test('readiness never sends the secret to a service that is not princess', async () => {
    const requests: RequestRecord[] = [];
    const { dependencies } = createDependencies({
        fetchImplementation: asFetch(async (input, init) => {
            requests.push({ url: String(input), headers: init?.headers });

            return Response.json({ service: 'other', ready: true });
        })
    });

    await assert.rejects(
        waitForReadiness(dependencies, previewOrigin, secretToken, {
            deadline: dependencies.now() + 1000,
            intervalMilliseconds: 500
        }),
        PreviewOperatorError
    );
    assert.equal(requests.length > 0, true);
    assert.equal(
        requests.every(request => {
            return !request.url.endsWith('/health');
        }),
        true
    );
});

test('readiness times out with the last health status and no secrets', async () => {
    const { dependencies, output } = createDependencies({
        fetchImplementation: asFetch(async input => {
            if (String(input).endsWith('/health')) {
                return Response.json({ error: 'nope' }, { status: 401 });
            }

            return Response.json({ service: 'princess' });
        })
    });

    await assert.rejects(
        waitForReadiness(dependencies, previewOrigin, secretToken, {
            deadline: dependencies.now() + 10_000,
            intervalMilliseconds: 5000
        }),
        error => {
            return (
                error instanceof PreviewOperatorError &&
                error.message.includes('401') &&
                error.message.includes('Workers Builds') &&
                !error.message.includes(secretToken)
            );
        }
    );
    assertNoSensitiveValues(output);
});

test('readiness ignores oversized response bodies', async () => {
    const oversizedBody = JSON.stringify({
        service: 'princess',
        padding: 'x'.repeat(70 * 1024)
    });
    const streamed = createDependencies({
        fetchImplementation: asFetch(async () => {
            return new Response(oversizedBody);
        })
    });
    const declared = createDependencies({
        fetchImplementation: asFetch(async () => {
            return new Response('{"service":"princess"}', {
                headers: { 'content-length': String(70 * 1024) }
            });
        })
    });

    for (const { dependencies } of [streamed, declared]) {
        const result = await checkPreviewReadiness(
            dependencies,
            previewOrigin,
            secretToken
        );

        assert.equal(result.rootReady, false);
    }
});

const waitOptions = {
    timeoutMilliseconds: 30_000,
    readyTimeoutMilliseconds: 120_000,
    intervalMilliseconds: 10_000
};

const waitCommands = {
    [currentBranchCommand]: 'feat-demo',
    'git rev-parse HEAD': headSha,
    'git rev-parse @{u}': headSha
};

test('the full wait flow prints only events without secrets', async () => {
    await withPreviewEnvironment(async captured => {
        const requests: RequestRecord[] = [];
        const { dependencies, output } = createDependencies({
            runCommand: createRunCommand({
                ...waitCommands,
                [checkRunsEndpoint]: checkRunsJson(checkRun()),
                [statusEndpoint]: statusJson()
            }),
            fetchImplementation: createReadyFetch(requests)
        });

        await runPreviewCommand(
            'wait',
            ['--timeout-seconds', '30'],
            dependencies
        );

        assert.deepEqual(
            output.map(line => JSON.parse(line).event),
            [
                'preview_url_resolved',
                'preview_build_status',
                'preview_readiness',
                'preview_ready'
            ]
        );
        assert.equal(JSON.parse(output[0] as string).origin, previewOrigin);
        assert.equal(requests.length, 2);
        assertNoSensitiveValues([...output, ...captured]);
    });
});

test('readiness gets its own window after the build uses its whole budget', async () => {
    await withPreviewEnvironment(async () => {
        const clock = createClock();
        const startedAt = clock.now();
        let healthChecks = 0;
        const { dependencies } = createDependencies({
            now: clock.now,
            sleep: clock.sleep,
            runCommand: createRunCommand({
                ...waitCommands,
                [checkRunsEndpoint]: () => {
                    return clock.now() - startedAt >= 30_000
                        ? checkRunsJson(checkRun())
                        : checkRunsJson(
                              checkRun({
                                  status: 'in_progress',
                                  conclusion: null
                              })
                          );
                },
                [statusEndpoint]: statusJson()
            }),
            fetchImplementation: asFetch(async input => {
                if (!String(input).endsWith('/health')) {
                    return Response.json({ service: 'princess' });
                }

                healthChecks += 1;

                return healthChecks < 6
                    ? Response.json({ ready: false }, { status: 503 })
                    : Response.json({ service: 'princess', ready: true });
            })
        });

        await waitForPreview(dependencies, waitOptions);

        assert.equal(clock.now() - startedAt >= 80_000, true);
        assert.equal(healthChecks, 6);
    });
});

test('readiness is bounded by its own timeout, not the build timeout', async () => {
    await withPreviewEnvironment(async () => {
        const clock = createClock();
        const startedAt = clock.now();
        const { dependencies } = createDependencies({
            now: clock.now,
            sleep: clock.sleep,
            runCommand: createRunCommand({
                ...waitCommands,
                [checkRunsEndpoint]: checkRunsJson(checkRun()),
                [statusEndpoint]: statusJson()
            }),
            fetchImplementation: asFetch(async () => {
                throw new Error('connection refused');
            })
        });

        await assert.rejects(
            waitForPreview(dependencies, {
                ...waitOptions,
                readyTimeoutMilliseconds: 40_000
            }),
            /Timed out waiting for the preview/
        );
        assert.equal(clock.now() - startedAt, 40_000);
    });
});

test('the build budget is enforced separately from readiness', async () => {
    await withPreviewEnvironment(async () => {
        const { dependencies } = createDependencies({
            runCommand: createRunCommand({
                ...waitCommands,
                [checkRunsEndpoint]: checkRunsJson(
                    checkRun({ status: 'queued', conclusion: null })
                ),
                [statusEndpoint]: statusJson()
            })
        });

        await assert.rejects(
            waitForPreview(dependencies, waitOptions),
            /Timed out waiting for Workers Builds/
        );
    });
});

test('an unpushed HEAD is reported before the branch label is resolved', async () => {
    await withPreviewEnvironment(async () => {
        const { dependencies } = createDependencies({
            runCommand: createRunCommand({
                'git rev-parse HEAD': headSha,
                'git rev-parse @{u}': 'b'.repeat(40),
                [currentBranchCommand]: longBranch
            })
        });

        await assert.rejects(
            waitForPreview(dependencies, waitOptions),
            /HEAD is not pushed/
        );
    });
});

test('the build and readiness sleeps never overshoot their deadlines', async () => {
    const sleeps: number[] = [];
    const clock = createClock();
    const recordingSleep = async (milliseconds: number) => {
        sleeps.push(milliseconds);
        await clock.sleep(milliseconds);
    };
    const build = createDependencies({
        now: clock.now,
        sleep: recordingSleep,
        runCommand: createRunCommand({
            [checkRunsEndpoint]: checkRunsJson(
                checkRun({ status: 'queued', conclusion: null })
            ),
            [statusEndpoint]: statusJson()
        })
    });
    const startedAt = clock.now();

    await assert.rejects(
        waitForBuild(build.dependencies, headSha, {
            deadline: startedAt + 25_000,
            intervalMilliseconds: 10_000
        }),
        /Timed out/
    );
    assert.deepEqual(sleeps, [10_000, 10_000, 5000]);
    assert.equal(clock.now() - startedAt, 25_000);

    sleeps.length = 0;

    const readiness = createDependencies({
        now: clock.now,
        sleep: recordingSleep,
        fetchImplementation: asFetch(async () => {
            throw new Error('connection refused');
        })
    });
    const readinessStartedAt = clock.now();

    await assert.rejects(
        waitForReadiness(readiness.dependencies, previewOrigin, secretToken, {
            deadline: readinessStartedAt + 12_000,
            intervalMilliseconds: 5000
        }),
        /Timed out/
    );
    assert.deepEqual(sleeps, [5000, 5000, 2000]);
    assert.equal(clock.now() - readinessStartedAt, 12_000);
});

test('wait fails fast without the webhook secret', async () => {
    const previousSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

    Reflect.deleteProperty(process.env, 'TELEGRAM_WEBHOOK_SECRET');

    try {
        const { dependencies } = createDependencies();

        await assert.rejects(
            waitForPreview(dependencies, waitOptions),
            /TELEGRAM_WEBHOOK_SECRET/
        );
    } finally {
        if (previousSecret !== undefined) {
            process.env.TELEGRAM_WEBHOOK_SECRET = previousSecret;
        }
    }
});

test('chat and user ids must be safe integers', () => {
    assert.equal(parseChatId('123456789'), 123456789);
    assert.equal(parseChatId('-1001234567890'), -1001234567890);

    for (const value of [
        '',
        '0',
        '12.5',
        'abc',
        '1e3',
        '--5',
        '9007199254740993',
        ' 5'
    ]) {
        assert.throws(() => parseChatId(value), PreviewUsageError);
    }

    assert.throws(() => parseChatId(undefined), /requires --chat-id/);
    assert.equal(parseUserId(undefined), undefined);
    assert.equal(parseUserId('42'), 42);
    assert.throws(() => parseUserId('-42'), PreviewUsageError);
    assert.throws(() => parseUserId('abc'), PreviewUsageError);
});

test('argument parsing accepts both flag forms and defaults', () => {
    assert.deepEqual(parseUrlArguments([]), { branch: undefined });
    assert.deepEqual(parseUrlArguments(['--', '--branch=feat/x']), {
        branch: 'feat/x'
    });
    assert.deepEqual(parseWaitArguments([]), {
        timeoutMilliseconds: 600_000,
        readyTimeoutMilliseconds: 120_000,
        intervalMilliseconds: 10_000
    });
    assert.deepEqual(
        parseWaitArguments([
            '--timeout-seconds=5',
            '--ready-timeout-seconds',
            '7',
            '--interval-seconds',
            '2'
        ]),
        {
            timeoutMilliseconds: 5000,
            readyTimeoutMilliseconds: 7000,
            intervalMilliseconds: 2000
        }
    );
    assert.deepEqual(parsePointArguments([]), {
        dropPendingUpdates: true,
        noWait: false,
        timeoutMilliseconds: 600_000,
        readyTimeoutMilliseconds: 120_000,
        intervalMilliseconds: 10_000
    });
    assert.equal(
        parsePointArguments(['--drop-pending-updates=false', '--no-wait'])
            .dropPendingUpdates,
        false
    );
    assert.deepEqual(
        parseSmokeArguments(['--chat-id', '-100123', '--url', previewOrigin]),
        { chatId: -100123, userId: undefined, baseUrl: previewOrigin }
    );
    assert.deepEqual(
        parseSmokeArguments(['--chat-id', '-100123', '--user-id', '77']),
        { chatId: -100123, userId: 77, baseUrl: undefined }
    );
});

test('argument parsing rejects invalid input', () => {
    assert.throws(
        () => parseWaitArguments(['--timeout-seconds=0']),
        PreviewUsageError
    );
    assert.throws(
        () => parseWaitArguments(['--ready-timeout-seconds=abc']),
        PreviewUsageError
    );
    assert.throws(
        () => parsePointArguments(['--drop-pending-updates=maybe']),
        PreviewUsageError
    );
    assert.throws(
        () => parsePointArguments(['--no-wait=true']),
        PreviewUsageError
    );
    assert.throws(() => parseUrlArguments(['--bogus']), /Unknown option/);
    assert.throws(() => parseUrlArguments(['--branch']), /requires a value/);
    assert.throws(() => parseUrlArguments(['positional']), PreviewUsageError);
    assert.throws(
        () => parseSmokeArguments(['--url', previewOrigin]),
        /--chat-id/
    );
    assert.throws(
        () => parseFlags(['--x'], { valueFlags: [], booleanFlags: [] }),
        PreviewUsageError
    );
});

test('smoke --url must be a preview host of this worker', () => {
    for (const url of [
        'https://example.com',
        'https://evil.workers.dev',
        'https://x-princess.attacker.workers.dev',
        'https://princess.chernenko.workers.dev'
    ]) {
        assert.throws(
            () => parseSmokeArguments(['--chat-id', '1', '--url', url]),
            PreviewUsageError
        );
    }

    assert.equal(
        parseSmokeArguments([
            '--chat-id',
            '1',
            '--url',
            LONG_LIVED_PREVIEW_ORIGIN
        ]).baseUrl,
        LONG_LIVED_PREVIEW_ORIGIN
    );
});

test('the synthetic update is a valid private or supergroup /start message', () => {
    const privateUpdate = createSyntheticStartUpdate(42, 1_784_098_000_123);
    const groupUpdate = createSyntheticStartUpdate(
        -1001234567890,
        1_784_098_000_123
    );
    const memberUpdate = createSyntheticStartUpdate(
        -1001234567890,
        1_784_098_000_123,
        555
    );

    assert.equal(privateUpdate.update_id, 1_784_098_000_123);
    assert.equal(privateUpdate.message.date, 1_784_098_000);
    assert.equal(privateUpdate.message.chat.type, 'private');
    assert.equal(privateUpdate.message.chat.id, 42);
    assert.equal(privateUpdate.message.from.id, 42);
    assert.equal(privateUpdate.message.from.is_bot, false);
    assert.equal(privateUpdate.message.text, '/start');
    assert.deepEqual(privateUpdate.message.entities, [
        { offset: 0, length: 6, type: 'bot_command' }
    ]);
    assert.equal(groupUpdate.message.chat.type, 'supergroup');
    assert.equal(groupUpdate.message.chat.id, -1001234567890);
    assert.equal(groupUpdate.message.from.id > 0, true);
    assert.equal(memberUpdate.message.from.id, 555);
    assert.equal(Number.isSafeInteger(groupUpdate.message.message_id), true);
});

test('smoke announces the target, posts the update and prints status only', async () => {
    await withPreviewEnvironment(async captured => {
        let requestUrl = '';
        let requestInit: RequestInit | undefined;
        const { dependencies, output } = createDependencies({
            fetchImplementation: asFetch(async (input, init) => {
                requestUrl = String(input);
                requestInit = init;
                return new Response('ok', { status: 200 });
            })
        });

        await runPreviewCommand(
            'smoke',
            [
                '--chat-id',
                '-1001234567890',
                '--user-id',
                '555',
                '--url',
                previewOrigin
            ],
            dependencies
        );

        const body = JSON.parse(String(requestInit?.body));

        assert.equal(requestUrl, `${previewOrigin}${webhookPath}`);
        assert.equal(requestInit?.method, 'POST');
        assert.deepEqual(requestInit?.headers, {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': secretToken
        });
        assert.equal(body.message.chat.id, -1001234567890);
        assert.equal(body.message.from.id, 555);
        assert.deepEqual(
            output.map(line => JSON.parse(line)),
            [
                {
                    event: 'preview_smoke_sending',
                    origin: previewOrigin,
                    chatId: -1001234567890
                },
                { event: 'preview_smoke_accepted', status: 200 }
            ]
        );
        assertNoSensitiveValues([...output, ...captured]);
    });
});

test('smoke fails on a non-200 response without leaking secrets', async () => {
    await withPreviewEnvironment(async captured => {
        const { dependencies, output } = createDependencies({
            fetchImplementation: asFetch(async () => {
                return new Response(`${secretToken} ${webhookPath}`, {
                    status: 401
                });
            })
        });
        let failure: unknown;

        try {
            await runPreviewCommand(
                'smoke',
                ['--chat-id', '5', '--url', previewOrigin],
                dependencies
            );
        } catch (error) {
            failure = error;
        }

        assert.equal(failure instanceof PreviewOperatorError, true);
        assertNoSensitiveValues([
            ...output,
            ...captured,
            JSON.stringify(createFailureEvent(failure))
        ]);
        assert.match(JSON.stringify(createFailureEvent(failure)), /HTTP 401/);
        assert.equal(
            output.some(line => {
                return line.includes('preview_smoke_accepted');
            }),
            false
        );
    });
});

test('smoke requires a chat id', async () => {
    const { dependencies } = createDependencies();

    await assert.rejects(
        runPreviewCommand('smoke', [], dependencies),
        PreviewUsageError
    );
});

interface WebhookFake {
    fetchImplementation: typeof fetch;
    methods: string[];
    setUrls: string[];
}

const createWebhookFake = (
    initialUrl: string,
    options: { applySet?: boolean; username?: string } = {}
): WebhookFake => {
    const applySet = options.applySet ?? true;
    const username = options.username ?? 'princess_debug_bot';
    let currentUrl = initialUrl;
    const methods: string[] = [];
    const setUrls: string[] = [];
    const fetchImplementation = asFetch(async (input, init) => {
        const method = String(input).split('/').pop() ?? '';

        methods.push(method);

        if (method === 'getMe') {
            return Response.json({ ok: true, result: { username } });
        }

        if (method === 'setWebhook') {
            const parameters = new URLSearchParams(String(init?.body));
            const url = parameters.get('url') ?? '';

            setUrls.push(url);

            if (applySet) {
                currentUrl = url;
            }

            return Response.json({ ok: true, result: true });
        }

        return Response.json({
            ok: true,
            result: {
                url: currentUrl,
                pending_update_count: 0,
                allowed_updates: ['message'],
                max_connections: 1
            }
        });
    });

    return { fetchImplementation, methods, setUrls };
};

const pointDependencies = (
    fake: WebhookFake,
    overrides: Partial<PreviewDependencies> = {}
) => {
    return createDependencies({
        runCommand: createRunCommand({
            [currentBranchCommand]: 'feat/demo'
        }),
        telegram: { botToken, fetchImplementation: fake.fetchImplementation },
        ...overrides
    });
};

test('point reports the previous origin and sets the webhook', async () => {
    await withPreviewEnvironment(async captured => {
        const fake = createWebhookFake(`${otherOrigin}${webhookPath}`);
        const { dependencies, output } = pointDependencies(fake);

        await runPreviewCommand('point', ['--no-wait'], dependencies);

        const current = JSON.parse(output[0] as string);
        const info = JSON.parse(output[1] as string);

        assert.deepEqual(current, {
            event: 'preview_webhook_current',
            alreadyPointedAtTarget: false,
            previousOrigin: otherOrigin
        });
        assert.equal(info.urlMatchesExpected, true);
        assert.deepEqual(fake.methods, [
            'getMe',
            'getWebhookInfo',
            'setWebhook',
            'getWebhookInfo'
        ]);
        assert.deepEqual(fake.setUrls, [
            `https://feat-demo-princess.chernenko.workers.dev${webhookPath}`
        ]);
        assertNoSensitiveValues([...output, ...captured]);
    });
});

test('point omits the previous origin when already pointed at the target', async () => {
    await withPreviewEnvironment(async () => {
        const fake = createWebhookFake(
            `https://feat-demo-princess.chernenko.workers.dev${webhookPath}`
        );
        const { dependencies, output } = pointDependencies(fake);

        await runPreviewCommand('point', ['--no-wait'], dependencies);

        assert.deepEqual(JSON.parse(output[0] as string), {
            event: 'preview_webhook_current',
            alreadyPointedAtTarget: true
        });
    });
});

test('point fails when Telegram does not report the new URL', async () => {
    await withPreviewEnvironment(async captured => {
        const fake = createWebhookFake('', { applySet: false });
        const { dependencies, output } = pointDependencies(fake);

        await assert.rejects(
            runPreviewCommand('point', ['--no-wait'], dependencies),
            PreviewOperatorError
        );
        assertNoSensitiveValues([...output, ...captured]);
    });
});

test('point refuses a token that does not belong to the preview bot', async () => {
    await withPreviewEnvironment(async captured => {
        const fake = createWebhookFake(`${otherOrigin}${webhookPath}`, {
            username: 'princess_prod_bot'
        });
        const { dependencies, output } = pointDependencies(fake);
        let failure: unknown;

        try {
            await runPreviewCommand('point', ['--no-wait'], dependencies);
        } catch (error) {
            failure = error;
        }

        const lines = [
            ...output,
            ...captured,
            JSON.stringify(createFailureEvent(failure))
        ];

        assert.equal(failure instanceof PreviewOperatorError, true);
        assert.deepEqual(fake.methods, ['getMe']);
        assertNoSensitiveValues(lines);
        assert.equal(lines.join('\n').includes('princess_prod_bot'), false);
    });
});

test('point with the default wait path waits, sets and verifies the webhook', async () => {
    await withPreviewEnvironment(async captured => {
        const fake = createWebhookFake(`${otherOrigin}${webhookPath}`);
        const requests: RequestRecord[] = [];
        const readyFetch = createReadyFetch(requests);
        const { dependencies, output } = pointDependencies(fake, {
            runCommand: createRunCommand({
                ...waitCommands,
                [checkRunsEndpoint]: checkRunsJson(checkRun()),
                [statusEndpoint]: statusJson()
            }),
            fetchImplementation: readyFetch
        });

        await runPreviewCommand('point', [], dependencies);

        assert.deepEqual(
            output.map(line => {
                return JSON.parse(line).event;
            }),
            [
                'preview_url_resolved',
                'preview_build_status',
                'preview_readiness',
                'preview_ready',
                'preview_webhook_current',
                'telegram_webhook_info'
            ]
        );
        assert.equal(
            JSON.parse(output[4] as string).previousOrigin,
            otherOrigin
        );
        assert.equal(JSON.parse(output[5] as string).urlMatchesExpected, true);
        assert.deepEqual(fake.methods, [
            'getMe',
            'getWebhookInfo',
            'setWebhook',
            'getWebhookInfo'
        ]);
        assert.deepEqual(
            requests.map(request => request.url),
            [`${previewOrigin}/`, `${previewOrigin}/health`]
        );
        assertNoSensitiveValues([...output, ...captured]);
    });
});

test('reset points the webhook at the long-lived preview', async () => {
    await withPreviewEnvironment(async captured => {
        const fake = createWebhookFake(`${otherOrigin}${webhookPath}`);
        const { dependencies, output } = createDependencies({
            telegram: {
                botToken,
                fetchImplementation: fake.fetchImplementation
            }
        });

        await runPreviewCommand('reset', [], dependencies);

        assert.deepEqual(fake.setUrls, [
            `${LONG_LIVED_PREVIEW_ORIGIN}${webhookPath}`
        ]);
        assert.equal(JSON.parse(output[0] as string).urlMatchesExpected, true);
        assertNoSensitiveValues([...output, ...captured]);
    });
});

test('reset refuses a token that does not belong to the preview bot', async () => {
    await withPreviewEnvironment(async () => {
        const fake = createWebhookFake('', { username: 'princess_prod_bot' });
        const { dependencies } = createDependencies({
            telegram: {
                botToken,
                fetchImplementation: fake.fetchImplementation
            }
        });

        await assert.rejects(
            runPreviewCommand('reset', [], dependencies),
            PreviewOperatorError
        );
        assert.deepEqual(fake.methods, ['getMe']);
        assert.deepEqual(fake.setUrls, []);
    });
});

const worktreeRoot = '/repo/.herdr/worktrees/feat';
const mainRoot = '/repo';
const worktreeFile = `${worktreeRoot}/.dev.vars.preview`;
const mainFile = `${mainRoot}/.dev.vars.preview`;
const commonDirCommand = `git -C ${worktreeRoot} rev-parse --git-common-dir`;

const loadWithFiles = async (
    existingFiles: string[],
    commonDirectory: string | Error
) => {
    const environment: Record<string, string | undefined> = {
        BOT_TOKEN: 'production-token',
        TELEGRAM_WEBHOOK_SECRET: 'production-secret',
        TELEGRAM_WEBHOOK_PATH: '/production-path',
        UNRELATED: 'kept'
    };
    const loaded: string[] = [];
    const envFilePath = await loadPreviewEnvironment({
        runCommand: createRunCommand({ [commonDirCommand]: commonDirectory }),
        environment,
        cwd: worktreeRoot,
        fileExists: filePath => {
            return existingFiles.includes(filePath);
        },
        load: (filePath, target) => {
            loaded.push(filePath);
            target.BOT_TOKEN = botToken;
        }
    });

    return { environment, loaded, envFilePath };
};

test('the preview environment file overrides inherited secrets', async () => {
    const { environment, loaded } = await loadWithFiles(
        [worktreeFile],
        `${mainRoot}/.git`
    );

    assert.deepEqual(loaded, [worktreeFile]);
    assert.equal(environment.BOT_TOKEN, botToken);
    assert.equal(environment.TELEGRAM_WEBHOOK_SECRET, undefined);
    assert.equal(environment.TELEGRAM_WEBHOOK_PATH, undefined);
    assert.equal(environment.UNRELATED, 'kept');
});

test('the working directory env file wins over the main checkout file', async () => {
    const { envFilePath } = await loadWithFiles(
        [worktreeFile, mainFile],
        `${mainRoot}/.git`
    );

    assert.equal(envFilePath, worktreeFile);
});

test('a worktree falls back to the main checkout env file', async () => {
    const { envFilePath, loaded } = await loadWithFiles(
        [mainFile],
        `${mainRoot}/.git`
    );

    assert.equal(envFilePath, mainFile);
    assert.deepEqual(loaded, [mainFile]);
});

test('a relative git common dir resolves against the working directory', async () => {
    const { envFilePath } = await loadWithFiles([worktreeFile], '.git');

    assert.equal(envFilePath, worktreeFile);
});

test('a missing env file names every location searched', async () => {
    for (const commonDirectory of [`${mainRoot}/.git`, new Error('not git')]) {
        await assert.rejects(loadWithFiles([], commonDirectory), error => {
            return (
                error instanceof PreviewOperatorError &&
                error.message.includes(worktreeFile) &&
                (commonDirectory instanceof Error ||
                    error.message.includes(mainFile))
            );
        });
    }
});

test('a missing env file leaves inherited secrets untouched', async () => {
    const environment: Record<string, string | undefined> = {
        BOT_TOKEN: 'production-token'
    };

    await assert.rejects(
        loadPreviewEnvironment({
            runCommand: createRunCommand({
                [commonDirCommand]: `${mainRoot}/.git`
            }),
            environment,
            cwd: worktreeRoot,
            fileExists: () => false
        }),
        PreviewOperatorError
    );
    assert.equal(environment.BOT_TOKEN, 'production-token');
});

test('url needs no env file and no secrets', async () => {
    const previous = {
        BOT_TOKEN: process.env.BOT_TOKEN,
        TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
        TELEGRAM_WEBHOOK_PATH: process.env.TELEGRAM_WEBHOOK_PATH
    };

    for (const name of Object.keys(previous)) {
        Reflect.deleteProperty(process.env, name);
    }

    try {
        const { dependencies, output } = createDependencies({
            runCommand: createRunCommand({
                [currentBranchCommand]: 'feat-demo'
            })
        });

        await runPreviewCommand('url', [], dependencies);

        assert.deepEqual(output, [previewOrigin]);
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value !== undefined) {
                process.env[name] = value;
            }
        }
    }
});

test('unknown or missing subcommands are usage errors', async () => {
    const { dependencies } = createDependencies();

    await assert.rejects(
        runPreviewCommand(undefined, [], dependencies),
        PreviewUsageError
    );
    await assert.rejects(
        runPreviewCommand('deploy', [], dependencies),
        PreviewUsageError
    );
});

test('url prints only the origin', async () => {
    const { dependencies, output } = createDependencies();

    await runPreviewCommand('url', ['--branch', 'Feat/Demo'], dependencies);

    assert.deepEqual(output, [
        'https://feat-demo-princess.chernenko.workers.dev'
    ]);
});

test('failure events expose messages only for safe errors', () => {
    assert.deepEqual(
        createFailureEvent(new PreviewOperatorError('HEAD is not pushed')),
        {
            event: 'preview_command_failed',
            errorType: 'PreviewOperatorError',
            message: 'HEAD is not pushed'
        }
    );
    assert.deepEqual(
        createFailureEvent(
            new Error('Missing required environment variable: BOT_TOKEN')
        ),
        {
            event: 'preview_command_failed',
            errorType: 'Error',
            message: 'Missing required environment variable: BOT_TOKEN'
        }
    );
    assert.deepEqual(
        createFailureEvent(new Error(`fetch failed for ${webhookPath}`)),
        { event: 'preview_command_failed', errorType: 'Error' }
    );
    assert.deepEqual(createFailureEvent('boom'), {
        event: 'preview_command_failed',
        errorType: 'string'
    });
});

test('Telegram API failures pass through only a sanitized description', () => {
    assert.deepEqual(
        createFailureEvent(
            new Error(
                "Telegram API setWebhook failed: Bad Request: can't parse message_id."
            )
        ),
        {
            event: 'preview_command_failed',
            errorType: 'Error',
            message:
                "Telegram API setWebhook failed: Bad Request: can't parse message_id."
        }
    );

    for (const description of [
        'Bad Request: bad webhook: HTTPS url must be provided',
        `Bad Request: ${webhookPath}`,
        'Bad Request: see http://example.com',
        'x'.repeat(121),
        ''
    ]) {
        assert.deepEqual(
            createFailureEvent(
                new Error(`Telegram API setWebhook failed: ${description}`)
            ),
            { event: 'preview_command_failed', errorType: 'Error' }
        );
    }

    assert.deepEqual(
        createFailureEvent(
            new Error('Telegram API setWebhook timed out after 5ms')
        ),
        { event: 'preview_command_failed', errorType: 'Error' }
    );
});
