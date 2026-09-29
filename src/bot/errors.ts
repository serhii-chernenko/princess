export class BotUserError extends Error {
    readonly html: boolean;

    readonly silent: boolean;

    constructor(
        message: string,
        options?: { html?: boolean; silent?: boolean }
    ) {
        super(message);
        this.name = 'BotUserError';
        this.html = options?.html ?? false;
        this.silent = options?.silent ?? false;
    }
}

export const isBotUserError = (error: unknown): error is BotUserError => {
    return error instanceof BotUserError;
};
