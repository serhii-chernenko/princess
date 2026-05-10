import { message } from 'telegraf/filters';
import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';

import { createGameService } from '../services/game-service';
import { BotUserError, isBotUserError } from '../errors';
import {
    getAvailableLanguagesMessage,
    getCommandList,
    getCongratsMessages,
    getHelpEntries,
    getMessages
} from '../content/messages';
import {
    getLatestReleaseVersion as getReleaseVersion,
    renderReleaseNotes
} from '../content/releases';
import {
    getDefaultAppLocale,
    getAvailableLanguageCodes,
    normalizeAppLocale,
    type AppLocale
} from '../i18n';
import {
    formatUserName,
    getTelegramDate,
    isForwardedReply,
    randomInt
} from '../utils/telegram';
import type { WorkerBindings } from '../../worker/env';

const PRINCESS_STICKER_ID =
    'CAACAgIAAxkBAAI4P2evIVLlreY15PsmXGAHadnB7vj2AAJCAgACe8B9Ey8JprdoroWfNgQ';

type PrincessBot = Telegraf<Context>;
type ChatMemberReader = {
    getChatMember(
        chatId: number,
        userId: number
    ): Promise<
        ReturnType<Context['getChatMember']> extends Promise<infer T>
            ? T
            : never
    >;
};

const handleCommandError = async (
    ctx: Context,
    error: unknown,
    locale: AppLocale = getDefaultAppLocale()
) => {
    if (isBotUserError(error)) {
        if (error.silent) {
            return;
        }

        if (error.html) {
            await ctx.replyWithHTML(error.message);
            return;
        }

        await ctx.sendMessage(error.message);
        return;
    }

    console.error('princess bot command failure', error);
    await ctx.sendMessage(getMessages(locale).error());
};

const handleListenerError = async (
    ctx: Context,
    error: unknown,
    locale: AppLocale = getDefaultAppLocale()
) => {
    if (isBotUserError(error) && error.silent) {
        return;
    }

    await handleCommandError(ctx, error, locale);
};

const isPrivateChatStart = (ctx: Context) => {
    return ctx.from?.id === ctx.chat?.id;
};

const formatTopList = (
    players: Array<{
        player: {
            displayName: string;
        };
        member: {
            score: number;
        };
    }>
) => {
    return players
        .slice(0, 10)
        .map((player, index) => {
            if (index === 0) {
                return `${index + 1}. <strong>${player.player.displayName}</strong>: ${player.member.score} 👸`;
            }

            return `${index + 1}. ${player.player.displayName}: ${player.member.score}`;
        })
        .join('\n');
};

const formatAllPlayersList = (
    players: Array<{
        player: {
            displayName: string;
        };
        member: {
            score: number;
        };
    }>
) => {
    return players
        .map((player, index) => {
            return `${index + 1}. ${player.player.displayName}: ${player.member.score}`;
        })
        .join('\n');
};

const postPrintablePlayers = async (
    ctx: Context,
    players: Array<{
        player: {
            displayName: string;
        };
        member: {
            score: number;
        };
    }>,
    list: 'all' | 'top',
    locale: AppLocale
) => {
    const LL = getMessages(locale);

    if (list === 'top') {
        await ctx.replyWithHTML(
            `<strong>${LL.top()} (${Math.min(players.length, 10)}):</strong>\n\n${formatTopList(players)}`
        );
        return;
    }

    await ctx.replyWithHTML(
        `<strong>${LL.players()} (${players.length}):</strong>\n\n${formatAllPlayersList(players)}`
    );
};

const shouldSkipMessage = (ctx: Context) => {
    const messagePayload = ctx.message;

    if (!messagePayload || !('text' in messagePayload)) {
        return true;
    }

    if (messagePayload.text.includes('/')) {
        return true;
    }

    return isForwardedReply(messagePayload);
};

const getCommandActor = (ctx: Context) => {
    if (!ctx.from || !ctx.chat) {
        throw new Error('Missing Telegram actor or chat context');
    }

    return {
        chatId: ctx.chat.id,
        user: ctx.from
    };
};

const createChatMemberReader = (ctx: Context): ChatMemberReader => {
    return {
        getChatMember(_chatId, userId) {
            return ctx.getChatMember(userId);
        }
    };
};

const renderWinnerMessage = (ctxUser: Context['from'], locale: AppLocale) => {
    if (!ctxUser) {
        throw new Error('Missing Telegram user context');
    }

    const congratsMessages = getCongratsMessages(
        `<strong>${formatUserName(ctxUser)}</strong>`,
        locale
    );
    const congratsIndex = randomInt(0, congratsMessages.length - 1);
    const congratsMessage = congratsMessages[congratsIndex];

    if (!congratsMessage) {
        throw new Error('Missing congratulation message');
    }

    return congratsMessage;
};

const getRequestedLanguage = (ctx: Context) => {
    const messagePayload = ctx.message;

    if (!messagePayload || !('text' in messagePayload)) {
        return {
            raw: '',
            normalized: null
        };
    }

    const parts = messagePayload.text.trim().split(/\s+/);
    const raw = parts[1] || '';

    return {
        raw,
        normalized: normalizeAppLocale(raw)
    };
};

let cachedBot: PrincessBot | null = null;
let cachedToken = '';

export const createPrincessBot = (env: WorkerBindings) => {
    if (!env.BOT_TOKEN) {
        throw new Error('BOT_TOKEN is required to create the Telegram bot');
    }

    if (cachedBot && cachedToken === env.BOT_TOKEN) {
        return cachedBot;
    }

    const bot = new Telegraf<Context>(env.BOT_TOKEN);
    const game = createGameService(env);

    bot.catch(error => {
        console.error('telegraf middleware failure', error);
    });

    bot.start(async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            const LL = getMessages(locale);

            if (isPrivateChatStart(ctx)) {
                await ctx.replyWithHTML(
                    `${LL.greetings({
                        name: formatUserName(actor.user, 'name')
                    })}\n\n${LL.greetingsError()}`
                );
                return;
            }

            const actorMember = await ctx.getChatMember(actor.user.id);

            if (actorMember.user.is_bot) {
                await ctx.sendMessage(
                    LL.accessDenied({
                        name: formatUserName(actorMember.user)
                    })
                );
                return;
            }

            await game.ensureChannel(actor.chatId);
            await ctx.replyWithHTML(
                `${LL.greetings({
                    name: formatUserName(actor.user, 'name')
                })}\n\n<strong>${LL.commandsLabel()}:</strong>\n${getCommandList(locale).join('\n')}`
            );
        } catch (error) {
            await handleCommandError(ctx, error, locale);
        }
    });

    bot.help(async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            const LL = getMessages(locale);
            const faq = getHelpEntries(env, locale).map(
                ({ question, answer }) => {
                    return `<strong>${question}</strong>\n${answer}`;
                }
            );

            await ctx.replyWithHTML(
                LL.faq({
                    faq: faq.join('\n\n'),
                    mail: env.MAIL || ''
                })
            );
        } catch (error) {
            await handleCommandError(ctx, error, locale);
        }
    });

    bot.command('join', async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            const LL = getMessages(locale);
            const result = await game.joinChannel(
                actor.chatId,
                actor.user,
                locale
            );

            await ctx.sendMessage(
                result.state === 'already-active'
                    ? LL.alreadyJoin({
                          name: formatUserName(actor.user)
                      })
                    : LL.successJoin({
                          name: formatUserName(actor.user)
                      })
            );
        } catch (error) {
            await handleCommandError(ctx, error, locale);
        }
    });

    bot.command('leave', async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            const LL = getMessages(locale);
            await game.leaveChannel(actor.chatId, actor.user, locale);

            await ctx.sendMessage(
                LL.successLeave({
                    name: formatUserName(actor.user)
                })
            );
        } catch (error) {
            await handleCommandError(ctx, error, locale);
        }
    });

    bot.command('run', async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            const LL = getMessages(locale);
            const telegramDate = getTelegramDate(ctx.message?.date);
            const result = await game.runVote(
                actor.chatId,
                actor.user.id,
                telegramDate,
                createChatMemberReader(ctx),
                'manual',
                false,
                locale
            );
            const congratsMessage = renderWinnerMessage(
                result.winner.telegramMember.user,
                locale
            );

            await ctx.replyWithHTML(
                `${LL.winner({
                    name: formatUserName(
                        result.winner.telegramMember.user,
                        'name'
                    )
                })}<em>${congratsMessage} ❤️</em>`
            );
            await postPrintablePlayers(
                ctx,
                result.printablePlayers,
                'top',
                locale
            );
            await game.cleanupInactiveChannels(
                new Date(Date.now() - 30 * 24 * 3600 * 1000)
            );
        } catch (error) {
            await handleCommandError(ctx, error, locale);
        }
    });

    bot.command('sudorun', async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            const LL = getMessages(locale);
            const telegramDate = getTelegramDate(ctx.message?.date);
            const result = await game.runVote(
                actor.chatId,
                actor.user.id,
                telegramDate,
                createChatMemberReader(ctx),
                'manual',
                true,
                locale
            );
            const congratsMessage = renderWinnerMessage(
                result.winner.telegramMember.user,
                locale
            );

            await ctx.replyWithHTML(
                `${LL.winner({
                    name: formatUserName(
                        result.winner.telegramMember.user,
                        'name'
                    )
                })}<em>${congratsMessage} ❤️</em>`
            );
            await postPrintablePlayers(
                ctx,
                result.printablePlayers,
                'top',
                locale
            );
            await game.cleanupInactiveChannels(
                new Date(Date.now() - 30 * 24 * 3600 * 1000)
            );
        } catch (error) {
            await handleCommandError(ctx, error, locale);
        }
    });

    bot.command('list', async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            const { channel } = await game.getChannelAndActor(
                actor.chatId,
                actor.user.id,
                createChatMemberReader(ctx),
                'command',
                locale
            );

            if (!channel) {
                throw new BotUserError(getMessages(locale).hasNotData());
            }

            const printablePlayers = await game.getPrintablePlayers(
                actor.chatId,
                channel.id,
                createChatMemberReader(ctx),
                'all',
                locale
            );

            await postPrintablePlayers(ctx, printablePlayers, 'all', locale);
        } catch (error) {
            await handleCommandError(ctx, error, locale);
        }
    });

    bot.command('top', async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            const { channel } = await game.getChannelAndActor(
                actor.chatId,
                actor.user.id,
                createChatMemberReader(ctx),
                'command',
                locale
            );

            if (!channel) {
                throw new BotUserError(getMessages(locale).hasNotData());
            }

            const printablePlayers = await game.getPrintablePlayers(
                actor.chatId,
                channel.id,
                createChatMemberReader(ctx),
                'top',
                locale
            );

            await postPrintablePlayers(ctx, printablePlayers, 'top', locale);
        } catch (error) {
            await handleCommandError(ctx, error, locale);
        }
    });

    bot.command('reset', async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            const LL = getMessages(locale);
            const actorMember = await ctx.getChatMember(actor.user.id);

            if (
                actorMember.status !== 'creator' &&
                actorMember.status !== 'administrator'
            ) {
                throw new BotUserError(
                    LL.accessDenied({
                        name: formatUserName(actorMember.user)
                    })
                );
            }

            await game.resetScores(actor.chatId, locale);
            await ctx.sendMessage(LL.successReset());
        } catch (error) {
            await handleCommandError(ctx, error, locale);
        }
    });

    bot.command('stop', async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            const LL = getMessages(locale);
            const actorMember = await ctx.getChatMember(actor.user.id);

            if (
                actorMember.status !== 'creator' &&
                actorMember.status !== 'administrator'
            ) {
                throw new BotUserError(
                    LL.accessDenied({
                        name: formatUserName(actorMember.user)
                    })
                );
            }

            await game.stopChannel(actor.chatId, locale);
            await ctx.sendMessage(LL.successStop());
        } catch (error) {
            await handleCommandError(ctx, error, locale);
        }
    });

    bot.command('stats', async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            const LL = getMessages(locale);
            await game.cleanupInactiveChannels(
                new Date(Date.now() - 30 * 24 * 3600 * 1000)
            );

            const { channelsCount, playersCount } = await game.getStats();

            await ctx.replyWithHTML(
                LL.stats({
                    groups: channelsCount,
                    players: playersCount,
                    youtube: env.YT_CHANNEL || '',
                    mail: env.MAIL || ''
                })
            );
        } catch (error) {
            await handleCommandError(ctx, error, locale);
        }
    });

    bot.command('releases', async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            await ctx.replyWithHTML(renderReleaseNotes(0, locale));
        } catch (error) {
            await handleCommandError(ctx, error, locale);
        }
    });

    bot.command('lang', async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            const LL = getMessages(locale);
            const { raw, normalized } = getRequestedLanguage(ctx);

            if (!raw) {
                await ctx.sendMessage(getAvailableLanguagesMessage(locale));
                return;
            }

            if (!normalized) {
                await ctx.sendMessage(
                    LL.lang.invalid({
                        language: raw,
                        languages: getAvailableLanguageCodes().join(', ')
                    })
                );
                return;
            }

            await game.setChannelLocale(actor.chatId, normalized);
            const nextLL = getMessages(normalized);

            await ctx.sendMessage(
                nextLL.lang.updated({
                    language: normalized
                })
            );
        } catch (error) {
            await handleCommandError(ctx, error, locale);
        }
    });

    bot.hears(/принцес/i, async ctx => {
        await ctx.replyWithSticker(PRINCESS_STICKER_ID);
    });

    bot.on(message('text'), async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (shouldSkipMessage(ctx)) {
                return;
            }

            if (!ctx.from || !ctx.chat) {
                return;
            }

            locale = await game.getChannelLocale(ctx.chat.id);
            const LL = getMessages(locale);
            const result = await game.runVote(
                ctx.chat.id,
                ctx.from.id,
                getTelegramDate(ctx.message.date),
                createChatMemberReader(ctx),
                'auto',
                false,
                locale
            );
            const congratsMessage = renderWinnerMessage(
                result.winner.telegramMember.user,
                locale
            );

            await ctx.replyWithHTML(
                `${LL.winner({
                    name: formatUserName(
                        result.winner.telegramMember.user,
                        'name'
                    )
                })}<em>${congratsMessage} ❤️</em>`
            );
            await postPrintablePlayers(
                ctx,
                result.printablePlayers,
                'top',
                locale
            );
        } catch (error) {
            await handleListenerError(ctx, error, locale);
        }
    });

    cachedBot = bot;
    cachedToken = env.BOT_TOKEN;

    return bot;
};

export const getCurrentReleaseVersion = () => {
    return getReleaseVersion();
};
