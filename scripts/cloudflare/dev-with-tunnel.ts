import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

import { loadOptionalEnvFile } from './runtime-env';

const wranglerReadyPattern =
    /Ready on http:\/\/(?:127\.0\.0\.1|localhost):8787/;
const cloudflaredConfigPath = 'cloudflared.yml';

const runCommand = (command: string, args: string[], label: string) => {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: 'inherit',
            env: process.env
        });

        child.on('error', error => {
            reject(new Error(`${label} failed to start: ${String(error)}`));
        });

        child.on('exit', code => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(`${label} exited with code ${code}`));
        });
    });
};

const terminateChild = (child: ChildProcess | null) => {
    if (!child || child.killed) {
        return;
    }

    child.kill('SIGINT');
};

const run = async () => {
    loadOptionalEnvFile('local');

    let cloudflaredChild: ChildProcess | null = null;
    let wranglerChild: ChildProcess | null = null;
    let shuttingDown = false;
    let webhookRegistered = false;

    if (fs.existsSync(cloudflaredConfigPath)) {
        cloudflaredChild = spawn(
            'cloudflared',
            ['tunnel', '--config', cloudflaredConfigPath, 'run'],
            {
                stdio: 'inherit',
                env: process.env
            }
        );

        cloudflaredChild.on('error', error => {
            console.warn(
                `cloudflared did not start. Continue without managed tunnel: ${String(error)}`
            );
        });
    } else {
        console.warn(
            'cloudflared.yml was not found. Continue with wrangler dev without starting a tunnel.'
        );
    }

    const cleanup = async () => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;

        if (webhookRegistered) {
            try {
                await runCommand(
                    'pnpm',
                    [
                        'exec',
                        'tsx',
                        'scripts/telegram/webhook.ts',
                        'delete',
                        'local'
                    ],
                    'local webhook delete'
                );
            } catch (error) {
                console.warn(String(error));
            }
        }

        terminateChild(cloudflaredChild);
        terminateChild(wranglerChild);
    };

    process.on('SIGINT', () => {
        void cleanup();
    });

    process.on('SIGTERM', () => {
        void cleanup();
    });

    await new Promise<void>((resolve, reject) => {
        wranglerChild = spawn('pnpm', ['exec', 'wrangler', 'dev'], {
            stdio: ['inherit', 'pipe', 'pipe'],
            env: process.env
        });

        const handleReadyOutput = async (chunk: Buffer) => {
            const output = chunk.toString();
            process.stdout.write(output);

            if (!wranglerReadyPattern.test(output) || webhookRegistered) {
                return;
            }

            webhookRegistered = true;

            try {
                await runCommand(
                    'pnpm',
                    [
                        'exec',
                        'tsx',
                        'scripts/telegram/webhook.ts',
                        'set',
                        'local'
                    ],
                    'local webhook set'
                );
            } catch (error) {
                console.warn(String(error));
            }
        };

        wranglerChild.stdout?.on('data', chunk => {
            void handleReadyOutput(chunk);
        });

        wranglerChild.stderr?.on('data', chunk => {
            process.stderr.write(chunk);
        });

        wranglerChild.on('error', error => {
            void cleanup().finally(() => {
                reject(error);
            });
        });

        wranglerChild.on('exit', (code, signal) => {
            void cleanup().finally(() => {
                if (code === 0) {
                    resolve();
                    return;
                }

                if (
                    shuttingDown &&
                    (signal === 'SIGINT' ||
                        signal === 'SIGTERM' ||
                        code === null)
                ) {
                    resolve();
                    return;
                }

                reject(
                    new Error(
                        `wrangler dev exited with code ${String(code)} and signal ${String(signal)}`
                    )
                );
            });
        });
    });
};

void run();
