import { message } from 'telegraf/filters';
import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';

import { createGameService } from '../services/game-service';
import { BotUserError, isBotUserError } from '../errors';
import { messages } from '../content/messages';
import {
    getLatestReleaseVersion,
    renderReleaseNotes
} from '../content/releases';
import { replaceTemplate } from '../utils/strings';
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

const handleCommandError = async (ctx: Context, error: unknown) => {
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
    await ctx.sendMessage(messages.error);
};

const handleListenerError = async (ctx: Context, error: unknown) => {
    if (isBotUserError(error) && error.silent) {
        return;
    }

    await handleCommandError(ctx, error);
};

const isPrivateChatStart = (ctx: Context) => {
    return ctx.from?.id === ctx.chat?.id;
};

const getEnvValue = (value: string | undefined, fallback = '') => {
    return value || fallback;
};

const formatHelpAnswer = (answer: string, env: WorkerBindings) => {
    return replaceTemplate(answer, {
        '%youtube': getEnvValue(env.YT_CHANNEL),
        '%tgChannel': getEnvValue(env.TG_CHANNEL),
        '%tgGroup': getEnvValue(env.TG_GROUP),
        '%wishlistUrlTg': getEnvValue(env.WISHLIST_TG_URL),
        '%chatGPTUrlGH': getEnvValue(env.CHATGPT_GITHUB_REPO_URL)
    });
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
    list: 'all' | 'top'
) => {
    if (list === 'top') {
        await ctx.replyWithHTML(
            `<strong>${messages.top} (${Math.min(players.length, 10)}):</strong>\n\n${formatTopList(players)}`
        );
        return;
    }

    await ctx.replyWithHTML(
        `<strong>${messages.players} (${players.length}):</strong>\n\n${formatAllPlayersList(players)}`
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
        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);

            if (isPrivateChatStart(ctx)) {
                await ctx.replyWithHTML(
                    messages.greetings.replace(
                        '%s',
                        formatUserName(actor.user, 'name')
                    ) + `\n\n${messages.greetingsError}`
                );
                return;
            }

            const actorMember = await ctx.getChatMember(actor.user.id);

            if (actorMember.user.is_bot) {
                await ctx.sendMessage(
                    messages.accessDenied.replace(
                        '%s',
                        formatUserName(actorMember.user)
                    )
                );
                return;
            }

            await game.ensureChannel(actor.chatId);
            await ctx.replyWithHTML(
                messages.greetings.replace(
                    '%s',
                    formatUserName(actor.user, 'name')
                ) +
                    `\n\n<strong>${messages.commandsLabel}:</strong>\n${messages.commands.join('\n')}`
            );
        } catch (error) {
            await handleCommandError(ctx, error);
        }
    });

    bot.help(async ctx => {
        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const faq = messages.help.map(({ question, answer }) => {
                return `<strong>${question}</strong>\n${formatHelpAnswer(answer, env)}`;
            });

            await ctx.replyWithHTML(
                replaceTemplate(messages.faq, {
                    '%faq': faq.join('\n\n'),
                    '%twitter': getEnvValue(env.AUTHOR_TWITTER_LINK),
                    '%tgGroup': getEnvValue(env.TG_GROUP),
                    '%mail': getEnvValue(env.MAIL)
                })
            );
        } catch (error) {
            await handleCommandError(ctx, error);
        }
    });

    bot.command('join', async ctx => {
        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            const result = await game.joinChannel(actor.chatId, actor.user);
            const message =
                result.state === 'already-active'
                    ? messages.alreadyJoin
                    : messages.successJoin;

            await ctx.sendMessage(
                message.replace('%s', formatUserName(actor.user))
            );
        } catch (error) {
            await handleCommandError(ctx, error);
        }
    });

    bot.command('leave', async ctx => {
        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            await game.leaveChannel(actor.chatId, actor.user);

            await ctx.sendMessage(
                messages.successLeave.replace('%s', formatUserName(actor.user))
            );
        } catch (error) {
            await handleCommandError(ctx, error);
        }
    });

    bot.command('run', async ctx => {
        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            const telegramDate = getTelegramDate(ctx.message?.date);
            const result = await game.runVote(
                actor.chatId,
                actor.user.id,
                telegramDate,
                createChatMemberReader(ctx),
                'manual'
            );
            const congratsIndex = randomInt(0, messages.congrats.length - 1);
            const congratsMessage = messages.congrats[congratsIndex];

            if (!congratsMessage) {
                throw new Error('Missing congratulation message');
            }

            await ctx.replyWithHTML(
                messages.winner.replace(
                    '%name',
                    formatUserName(result.winner.telegramMember.user, 'name')
                ) +
                    `<em>${congratsMessage.replace(
                        '%nick',
                        `<strong>${formatUserName(result.winner.telegramMember.user)}</strong>`
                    )} ❤️</em>`
            );
            await postPrintablePlayers(ctx, result.printablePlayers, 'top');
            await game.cleanupInactiveChannels(
                new Date(Date.now() - 30 * 24 * 3600 * 1000)
            );
        } catch (error) {
            await handleCommandError(ctx, error);
        }
    });

    bot.command('sudorun', async ctx => {
        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            const telegramDate = getTelegramDate(ctx.message?.date);
            const result = await game.runVote(
                actor.chatId,
                actor.user.id,
                telegramDate,
                createChatMemberReader(ctx),
                'manual',
                true
            );
            const congratsIndex = randomInt(0, messages.congrats.length - 1);
            const congratsMessage = messages.congrats[congratsIndex];

            if (!congratsMessage) {
                throw new Error('Missing congratulation message');
            }

            await ctx.replyWithHTML(
                messages.winner.replace(
                    '%name',
                    formatUserName(result.winner.telegramMember.user, 'name')
                ) +
                    `<em>${congratsMessage.replace(
                        '%nick',
                        `<strong>${formatUserName(result.winner.telegramMember.user)}</strong>`
                    )} ❤️</em>`
            );
            await postPrintablePlayers(ctx, result.printablePlayers, 'top');
            await game.cleanupInactiveChannels(
                new Date(Date.now() - 30 * 24 * 3600 * 1000)
            );
        } catch (error) {
            await handleCommandError(ctx, error);
        }
    });

    bot.command('list', async ctx => {
        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            const { channel } = await game.getChannelAndActor(
                actor.chatId,
                actor.user.id,
                createChatMemberReader(ctx),
                'command'
            );

            if (!channel) {
                throw new BotUserError(messages.hasNotData);
            }

            const printablePlayers = await game.getPrintablePlayers(
                actor.chatId,
                channel.id,
                createChatMemberReader(ctx),
                'all'
            );

            await postPrintablePlayers(ctx, printablePlayers, 'all');
        } catch (error) {
            await handleCommandError(ctx, error);
        }
    });

    bot.command('top', async ctx => {
        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            const { channel } = await game.getChannelAndActor(
                actor.chatId,
                actor.user.id,
                createChatMemberReader(ctx),
                'command'
            );

            if (!channel) {
                throw new BotUserError(messages.hasNotData);
            }

            const printablePlayers = await game.getPrintablePlayers(
                actor.chatId,
                channel.id,
                createChatMemberReader(ctx),
                'top'
            );

            await postPrintablePlayers(ctx, printablePlayers, 'top');
        } catch (error) {
            await handleCommandError(ctx, error);
        }
    });

    bot.command('reset', async ctx => {
        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            const actorMember = await ctx.getChatMember(actor.user.id);

            if (
                actorMember.status !== 'creator' &&
                actorMember.status !== 'administrator'
            ) {
                throw new BotUserError(
                    messages.accessDenied.replace(
                        '%s',
                        formatUserName(actorMember.user)
                    )
                );
            }

            await game.resetScores(actor.chatId);
            await ctx.sendMessage(messages.successReset);
        } catch (error) {
            await handleCommandError(ctx, error);
        }
    });

    bot.command('stop', async ctx => {
        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            const actorMember = await ctx.getChatMember(actor.user.id);

            if (
                actorMember.status !== 'creator' &&
                actorMember.status !== 'administrator'
            ) {
                throw new BotUserError(
                    messages.accessDenied.replace(
                        '%s',
                        formatUserName(actorMember.user)
                    )
                );
            }

            await game.stopChannel(actor.chatId);
            await ctx.sendMessage(messages.successStop);
        } catch (error) {
            await handleCommandError(ctx, error);
        }
    });

    bot.command('stats', async ctx => {
        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            await game.cleanupInactiveChannels(
                new Date(Date.now() - 30 * 24 * 3600 * 1000)
            );

            const { channelsCount, playersCount } = await game.getStats();

            await ctx.replyWithHTML(
                replaceTemplate(messages.stats, {
                    '%groups': channelsCount.toString(),
                    '%players': playersCount.toString(),
                    '%youtube': getEnvValue(env.YT_CHANNEL),
                    '%twitter': getEnvValue(env.AUTHOR_TWITTER_LINK),
                    '%tgChannel': getEnvValue(env.TG_CHANNEL),
                    '%mail': getEnvValue(env.MAIL)
                })
            );
        } catch (error) {
            await handleCommandError(ctx, error);
        }
    });

    bot.command('releases', async ctx => {
        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            await ctx.replyWithHTML(renderReleaseNotes());
        } catch (error) {
            await handleCommandError(ctx, error);
        }
    });

    bot.hears(/принцес/i, async ctx => {
        await ctx.replyWithSticker(PRINCESS_STICKER_ID);
    });

    bot.on(message('text'), async ctx => {
        try {
            if (shouldSkipMessage(ctx)) {
                return;
            }

            if (!ctx.from || !ctx.chat) {
                return;
            }

            const result = await game.runVote(
                ctx.chat.id,
                ctx.from.id,
                getTelegramDate(ctx.message.date),
                createChatMemberReader(ctx),
                'auto'
            );
            const congratsIndex = randomInt(0, messages.congrats.length - 1);
            const congratsMessage = messages.congrats[congratsIndex];

            if (!congratsMessage) {
                throw new Error('Missing congratulation message');
            }

            await ctx.replyWithHTML(
                messages.winner.replace(
                    '%name',
                    formatUserName(result.winner.telegramMember.user, 'name')
                ) +
                    `<em>${congratsMessage.replace(
                        '%nick',
                        `<strong>${formatUserName(result.winner.telegramMember.user)}</strong>`
                    )} ❤️</em>`
            );
            await postPrintablePlayers(ctx, result.printablePlayers, 'top');
        } catch (error) {
            await handleListenerError(ctx, error);
        }
    });

    cachedBot = bot;
    cachedToken = env.BOT_TOKEN;

    return bot;
};

export const getCurrentReleaseVersion = () => {
    return getLatestReleaseVersion();
};
