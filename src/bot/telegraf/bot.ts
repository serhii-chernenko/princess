import { message } from 'telegraf/filters';
import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { ChatMember, User } from 'telegraf/types';

import { createGameService, isAdmin } from '../services/game-service';
import { BotUserError, isBotUserError } from '../errors';
import { renderDebugReport } from '../content/debug-report';
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
import { escapeHtml } from '../utils/strings';
import type { WorkerBindings } from '../../worker/env';

const GROUP_CHAT_TYPES: ReadonlySet<string> = new Set(['group', 'supergroup']);
const GROUP_COMMANDS_REQUIRING_BOT_NAME: ReadonlySet<string> = new Set([
    'stop',
    'reset',
    'forget',
    'restore'
]);

const PRINCESS_STICKER_ID =
    'CAACAgIAAxkBAAI4P2evIVLlreY15PsmXGAHadnB7vj2AAJCAgACe8B9Ey8JprdoroWfNgQ';

export interface PrincessBotTelemetry {
    botActionCompleted(input: {
        action:
            | 'join'
            | 'leave'
            | 'reset'
            | 'stop'
            | 'resume'
            | 'forget'
            | 'restore';
        result: 'joined' | 'reactivated' | 'already-active' | 'success';
    }): void;
    voteCompleted(input: {
        mode: 'auto' | 'manual' | 'sudo';
        eligibleCount: number;
        durationMs: number;
    }): void;
    internalFailure(input: {
        event:
            | 'generic_error_reply_failed'
            | 'group_command_hint_failed'
            | 'vote_announcement_failed'
            | 'telegraf_middleware_failed';
        errorType: string;
    }): void;
}

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
    locale: AppLocale = getDefaultAppLocale(),
    telemetry?: PrincessBotTelemetry
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

    try {
        await ctx.sendMessage(getMessages(locale).error());
    } catch (replyError) {
        telemetry?.internalFailure({
            event: 'generic_error_reply_failed',
            errorType: getErrorType(replyError)
        });
        console.error(
            JSON.stringify({
                event: 'generic_error_reply_failed',
                errorType: getErrorType(replyError)
            })
        );
    }

    throw error;
};

const handleListenerError = async (ctx: Context, error: unknown) => {
    if (isBotUserError(error)) {
        return;
    }

    throw error;
};

const getErrorType = (error: unknown) => {
    return error instanceof Error ? error.name : typeof error;
};

const assertHumanSender = (user: User, locale: AppLocale) => {
    if (user.is_bot) {
        throw new BotUserError(
            getMessages(locale).accessDenied({
                name: formatUserName(user)
            })
        );
    }
};

const assertAdminActor = (actorMember: ChatMember, locale: AppLocale) => {
    if (!isAdmin(actorMember)) {
        throw new BotUserError(
            getMessages(locale).accessDenied({
                name: formatUserName(actorMember.user)
            })
        );
    }
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
                return `${index + 1}. <strong>${escapeHtml(player.player.displayName)}</strong>: ${player.member.score} 👸`;
            }

            return `${index + 1}. ${escapeHtml(player.player.displayName)}: ${player.member.score}`;
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
            return `${index + 1}. ${escapeHtml(player.player.displayName)}: ${player.member.score}`;
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

const getUnaddressedGroupCommand = (ctx: Context) => {
    if (!ctx.chat || !GROUP_CHAT_TYPES.has(ctx.chat.type)) {
        return null;
    }

    const messagePayload = ctx.message;

    if (!messagePayload || !('text' in messagePayload)) {
        return null;
    }

    if (isForwardedReply(messagePayload)) {
        return null;
    }

    const commandEntity = messagePayload.entities?.[0];

    if (commandEntity?.type !== 'bot_command' || commandEntity.offset > 0) {
        return null;
    }

    const [commandPart, addressee] = messagePayload.text
        .slice(0, commandEntity.length)
        .split('@');
    const command = commandPart?.slice(1).toLowerCase();

    if (addressee || !command) {
        return null;
    }

    if (!GROUP_COMMANDS_REQUIRING_BOT_NAME.has(command)) {
        return null;
    }

    return { chatId: ctx.chat.id, command };
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

const readLiveMemberStatus = async (ctx: Context, userId: number) => {
    try {
        const member = await ctx.getChatMember(userId);

        return member.status;
    } catch {
        return null;
    }
};

const renderWinnerMessage = (ctxUser: Context['from'], locale: AppLocale) => {
    if (!ctxUser) {
        throw new Error('Missing Telegram user context');
    }

    const congratsMessages = getCongratsMessages(
        `<strong>${escapeHtml(formatUserName(ctxUser))}</strong>`,
        locale
    );
    const congratsIndex = randomInt(0, congratsMessages.length - 1);
    const congratsMessage = congratsMessages[congratsIndex];

    if (!congratsMessage) {
        throw new Error('Missing congratulation message');
    }

    return congratsMessage;
};

const announceWinner = async (
    ctx: Context,
    result: {
        printablePlayers: Parameters<typeof postPrintablePlayers>[1];
        winner: {
            player: { id: number };
            telegramMember: { user: User };
        };
    },
    locale: AppLocale,
    telemetry?: PrincessBotTelemetry
) => {
    const LL = getMessages(locale);

    try {
        const congratsMessage = renderWinnerMessage(
            result.winner.telegramMember.user,
            locale
        );

        await ctx.replyWithHTML(
            `${LL.winner({
                name: escapeHtml(
                    formatUserName(result.winner.telegramMember.user, 'name')
                )
            })}<em>${congratsMessage} ❤️</em>`
        );
        await postPrintablePlayers(ctx, result.printablePlayers, 'top', locale);
    } catch (error) {
        telemetry?.internalFailure({
            event: 'vote_announcement_failed',
            errorType: getErrorType(error)
        });
        console.error(
            JSON.stringify({
                event: 'vote_announcement_failed',
                errorType: getErrorType(error)
            })
        );

        throw error;
    }
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

export const createPrincessBot = (
    env: WorkerBindings,
    telemetry?: PrincessBotTelemetry
) => {
    if (!env.BOT_TOKEN) {
        throw new Error('BOT_TOKEN is required to create the Telegram bot');
    }

    const bot = new Telegraf<Context>(env.BOT_TOKEN);
    const game = createGameService(env);

    bot.catch(error => {
        telemetry?.internalFailure({
            event: 'telegraf_middleware_failed',
            errorType: getErrorType(error)
        });
        console.error(
            JSON.stringify({
                event: 'telegraf_middleware_failed',
                errorType: error instanceof Error ? error.name : typeof error
            })
        );
        throw error;
    });

    bot.use(async (ctx, next) => {
        const unaddressed = getUnaddressedGroupCommand(ctx);

        if (!unaddressed) {
            return next();
        }

        const locale = await game
            .getChannelLocale(unaddressed.chatId)
            .catch(() => getDefaultAppLocale());

        try {
            await ctx.sendMessage(
                getMessages(locale).groupCommandNeedsBotName({
                    command: unaddressed.command,
                    username: ctx.me
                })
            );
        } catch (error) {
            telemetry?.internalFailure({
                event: 'group_command_hint_failed',
                errorType: getErrorType(error)
            });
            console.error(
                JSON.stringify({
                    event: 'group_command_hint_failed',
                    errorType: getErrorType(error)
                })
            );
        }
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
                        name: escapeHtml(formatUserName(actor.user, 'name'))
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

            const { state } = await game.ensureChannel(
                actor.chatId,
                isAdmin(actorMember)
            );
            const resumeNotice =
                state === 'resumed' ? `${LL.successResume()}\n\n` : '';
            const stoppedNotice =
                state === 'stopped' ? `\n\n${LL.gameStopped()}` : '';

            if (state === 'resumed') {
                telemetry?.botActionCompleted({
                    action: 'resume',
                    result: 'success'
                });
            }

            const groupCommandsNote = LL.groupCommandsNote({
                username: ctx.me
            });

            await ctx.replyWithHTML(
                `${resumeNotice}${LL.greetings({
                    name: escapeHtml(formatUserName(actor.user, 'name'))
                })}\n\n<strong>${LL.commandsLabel()}:</strong>\n${getCommandList(locale).join('\n')}\n\n${groupCommandsNote}${stoppedNotice}`
            );
        } catch (error) {
            await handleCommandError(ctx, error, locale, telemetry);
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
            await handleCommandError(ctx, error, locale, telemetry);
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
            assertHumanSender(actor.user, locale);
            const result = await game.joinChannel(
                actor.chatId,
                actor.user,
                locale
            );
            telemetry?.botActionCompleted({
                action: 'join',
                result: result.state
            });

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
            await handleCommandError(ctx, error, locale, telemetry);
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
            assertHumanSender(actor.user, locale);
            await game.leaveChannel(actor.chatId, actor.user, locale);
            telemetry?.botActionCompleted({
                action: 'leave',
                result: 'success'
            });

            await ctx.sendMessage(
                LL.successLeave({
                    name: formatUserName(actor.user)
                })
            );
        } catch (error) {
            await handleCommandError(ctx, error, locale, telemetry);
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
            const telegramDate = getTelegramDate(ctx.message?.date);
            const startedAt = Date.now();
            const result = await game.runVote(
                actor.chatId,
                actor.user.id,
                telegramDate,
                createChatMemberReader(ctx),
                'manual',
                false,
                locale
            );
            telemetry?.voteCompleted({
                mode: 'manual',
                eligibleCount: result.eligibleCount,
                durationMs: Math.max(0, Date.now() - startedAt)
            });
            await announceWinner(ctx, result, locale, telemetry);
        } catch (error) {
            await handleCommandError(ctx, error, locale, telemetry);
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
            const telegramDate = getTelegramDate(ctx.message?.date);
            const startedAt = Date.now();
            const result = await game.runVote(
                actor.chatId,
                actor.user.id,
                telegramDate,
                createChatMemberReader(ctx),
                'manual',
                true,
                locale
            );
            telemetry?.voteCompleted({
                mode: 'sudo',
                eligibleCount: result.eligibleCount,
                durationMs: Math.max(0, Date.now() - startedAt)
            });
            await announceWinner(ctx, result, locale, telemetry);
        } catch (error) {
            await handleCommandError(ctx, error, locale, telemetry);
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
            await handleCommandError(ctx, error, locale, telemetry);
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
            await handleCommandError(ctx, error, locale, telemetry);
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

            if (isPrivateChatStart(ctx)) {
                await ctx.sendMessage(LL.greetingsError());
                return;
            }

            const { actorMember } = await game.getChannelAndActor(
                actor.chatId,
                actor.user.id,
                createChatMemberReader(ctx),
                'command',
                locale
            );

            assertAdminActor(actorMember, locale);

            await game.resetScores(actor.chatId, locale);
            telemetry?.botActionCompleted({
                action: 'reset',
                result: 'success'
            });
            await ctx.sendMessage(LL.successReset({ username: ctx.me }));
        } catch (error) {
            await handleCommandError(ctx, error, locale, telemetry);
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

            if (isPrivateChatStart(ctx)) {
                await ctx.sendMessage(LL.greetingsError());
                return;
            }

            const { actorMember } = await game.getChannelAndActor(
                actor.chatId,
                actor.user.id,
                createChatMemberReader(ctx),
                'command',
                locale
            );

            assertAdminActor(actorMember, locale);

            await game.stopChannel(actor.chatId, locale);
            telemetry?.botActionCompleted({
                action: 'stop',
                result: 'success'
            });
            await ctx.sendMessage(LL.successStop());
        } catch (error) {
            await handleCommandError(ctx, error, locale, telemetry);
        }
    });

    bot.command('forget', async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            const LL = getMessages(locale);

            if (isPrivateChatStart(ctx)) {
                await ctx.sendMessage(LL.greetingsError());
                return;
            }

            const { actorMember } = await game.getChannelAndActor(
                actor.chatId,
                actor.user.id,
                createChatMemberReader(ctx),
                'command',
                locale
            );

            assertAdminActor(actorMember, locale);

            await game.forgetChannel(actor.chatId, locale);
            telemetry?.botActionCompleted({
                action: 'forget',
                result: 'success'
            });
            await ctx.sendMessage(LL.successForget({ username: ctx.me }));
        } catch (error) {
            await handleCommandError(ctx, error, locale, telemetry);
        }
    });

    bot.command('restore', async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            const LL = getMessages(locale);

            if (isPrivateChatStart(ctx)) {
                await ctx.sendMessage(LL.greetingsError());
                return;
            }

            const actorMember = await game.getActorMember(
                actor.chatId,
                actor.user.id,
                createChatMemberReader(ctx),
                'command',
                locale
            );

            assertAdminActor(actorMember, locale);

            const { locale: restoredLocale } = await game.restoreChannel(
                actor.chatId,
                locale
            );
            telemetry?.botActionCompleted({
                action: 'restore',
                result: 'success'
            });
            await ctx.sendMessage(getMessages(restoredLocale).successRestore());
        } catch (error) {
            await handleCommandError(ctx, error, locale, telemetry);
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
            await handleCommandError(ctx, error, locale, telemetry);
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
            await handleCommandError(ctx, error, locale, telemetry);
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

            const { actorMember } = await game.getChannelAndActor(
                actor.chatId,
                actor.user.id,
                createChatMemberReader(ctx),
                'command',
                locale
            );

            assertAdminActor(actorMember, locale);
            await game.setChannelLocale(actor.chatId, normalized, locale);
            const nextLL = getMessages(normalized);

            await ctx.sendMessage(
                nextLL.lang.updated({
                    language: normalized
                })
            );
        } catch (error) {
            await handleCommandError(ctx, error, locale, telemetry);
        }
    });

    bot.command('debug', async ctx => {
        let locale: AppLocale = getDefaultAppLocale();

        try {
            if (isForwardedReply(ctx.message)) {
                return;
            }

            const actor = getCommandActor(ctx);
            locale = await game.getChannelLocale(actor.chatId);
            const LL = getMessages(locale);
            const isPrivateChat = ctx.chat.type === 'private';
            const [info, userStatus, botStatus] = isPrivateChat
                ? [null, null, null]
                : await Promise.all([
                      game.getChannelDebugInfo(actor.chatId, actor.user.id),
                      readLiveMemberStatus(ctx, actor.user.id),
                      readLiveMemberStatus(ctx, ctx.botInfo.id)
                  ]);

            await ctx.replyWithHTML(
                renderDebugReport(
                    {
                        chatId: actor.chatId,
                        chatType: ctx.chat.type,
                        userId: actor.user.id,
                        environment: env.BOT_ENVIRONMENT,
                        currentReleaseVersion: getReleaseVersion(),
                        liveStatuses: isPrivateChat
                            ? null
                            : { user: userStatus, bot: botStatus },
                        info
                    },
                    LL
                )
            );
        } catch (error) {
            await handleCommandError(ctx, error, locale, telemetry);
        }
    });

    bot.hears(/принцес/i, async ctx => {
        await ctx.replyWithSticker(PRINCESS_STICKER_ID, {
            reply_parameters: {
                message_id: ctx.message.message_id
            }
        });
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
            const startedAt = Date.now();
            const result = await game.runVote(
                ctx.chat.id,
                ctx.from.id,
                getTelegramDate(ctx.message.date),
                createChatMemberReader(ctx),
                'auto',
                false,
                locale
            );
            telemetry?.voteCompleted({
                mode: 'auto',
                eligibleCount: result.eligibleCount,
                durationMs: Math.max(0, Date.now() - startedAt)
            });
            await announceWinner(ctx, result, locale, telemetry);
        } catch (error) {
            await handleListenerError(ctx, error);
        }
    });

    return bot;
};

export const getCurrentReleaseVersion = () => {
    return getReleaseVersion();
};
