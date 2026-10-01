import { Effect } from 'effect';
import type { ChatMember, User } from 'telegraf/types';

import { BotUserError } from '../errors';
import { getLatestReleaseVersion } from '../content/releases';
import type { ChannelDebugInfo } from '../content/debug-report';
import { getHourLabel, getMessages } from '../content/messages';
import {
    getDefaultAppLocale,
    normalizeAppLocale,
    type AppLocale
} from '../i18n';
import {
    formatUserName,
    isInactiveTelegramMember,
    randomInt
} from '../utils/telegram';
import {
    buildChannelSnapshotPayload,
    channelSnapshotPayloadMaxBytes,
    channelSnapshotRestoreMaxStatements,
    channelSnapshotRetentionMilliseconds,
    estimateChannelSnapshotRestoreStatements,
    parseChannelSnapshotPayload,
    serializeChannelSnapshotPayload
} from '../../db/channel-snapshot-payload';
import { createRepositories } from '../../db/repositories';
import type { NewChannelSnapshot } from '../../db/repositories/channel-snapshot-repository';
import { createDb } from '../../db/client';
import {
    channelMembers,
    channelSnapshotReasons,
    channels,
    players
} from '../../db/schema';
import type { WorkerBindings } from '../../worker/env';

type PlayerRow = typeof players.$inferSelect;
type ChannelMemberRow = typeof channelMembers.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;
type ChannelSnapshotReason = (typeof channelSnapshotReasons)[number];

type ActivePlayer = {
    member: ChannelMemberRow;
    player: PlayerRow;
    telegramMember: ChatMember;
};

type ChatMemberReader = {
    getChatMember(chatId: number, userId: number): Promise<ChatMember>;
};

type RunType = 'auto' | 'manual';

export const getSortedPrintablePlayers = <
    T extends {
        member: {
            score: number;
        };
    }
>(
    activePlayers: T[],
    list: 'all' | 'top'
) => {
    return activePlayers
        .filter(activePlayer => {
            return list !== 'top' || activePlayer.member.score > 0;
        })
        .sort((left, right) => {
            return right.member.score - left.member.score;
        });
};

const runEffect = <A>(effect: Effect.Effect<A, Error>) => {
    return Effect.runPromise(effect);
};

const getErrorType = (error: unknown) => {
    return error instanceof Error ? error.name : typeof error;
};

const getTelegramErrorCode = (error: unknown) => {
    if (typeof error !== 'object' || error === null) {
        return null;
    }

    const { code, response } = error as {
        code?: unknown;
        response?: { error_code?: unknown };
    };

    return response?.error_code ?? code ?? null;
};

const missingMemberDescriptionPattern =
    /user not found|member not found|participant_id_invalid|user_id_invalid/i;

const getTelegramErrorDescription = (error: unknown) => {
    if (typeof error !== 'object' || error === null) {
        return '';
    }

    const { response } = error as { response?: { description?: unknown } };

    return typeof response?.description === 'string'
        ? response.description
        : '';
};

export const isDefinitiveMissingMemberError = (error: unknown) => {
    return (
        getTelegramErrorCode(error) === 400 &&
        missingMemberDescriptionPattern.test(getTelegramErrorDescription(error))
    );
};

export const isAdmin = (member: Pick<ChatMember, 'status'>) => {
    return member.status === 'creator' || member.status === 'administrator';
};

export const assertGlobalCleanupAllowed = (
    env: Pick<WorkerBindings, 'BOT_ENVIRONMENT' | 'ENABLE_SCHEDULED_CLEANUP'>
) => {
    if (
        env.BOT_ENVIRONMENT !== 'local' &&
        env.BOT_ENVIRONMENT !== 'production'
    ) {
        throw new Error(
            'Global cleanup is forbidden outside the local or production owner environment'
        );
    }

    if (env.ENABLE_SCHEDULED_CLEANUP !== 'true') {
        throw new Error('Global cleanup is disabled by configuration');
    }
};

export const createGameService = (
    env: WorkerBindings,
    repositories: ReturnType<typeof createRepositories> = createRepositories(
        createDb(env)
    )
) => {
    const findChannel = async (telegramChatId: number) => {
        return runEffect(
            repositories.channels.findChannelByTelegramChatId(telegramChatId)
        );
    };

    const getChannelLocale = async (
        telegramChatId: number,
        fallbackLocale: AppLocale = getDefaultAppLocale()
    ) => {
        const channel = await findChannel(telegramChatId);
        const locale = normalizeAppLocale(channel?.language || fallbackLocale);

        return locale ?? fallbackLocale;
    };

    const findOrCreatePlayer = async (user: User) => {
        const existingPlayer = await runEffect(
            repositories.players.findPlayerByTelegramUserId(user.id)
        );

        if (existingPlayer) {
            const displayName = formatUserName(user, 'name');

            if (existingPlayer.displayName !== displayName) {
                await runEffect(
                    repositories.players.updateDisplayName(
                        existingPlayer.id,
                        displayName
                    )
                );
            }

            return (
                (await runEffect(
                    repositories.players.findPlayerByTelegramUserId(user.id)
                )) ?? existingPlayer
            );
        }

        const createdPlayer = await runEffect(
            repositories.players.createPlayer(
                user.id,
                formatUserName(user, 'name')
            )
        );

        if (!createdPlayer) {
            throw new Error('Failed to create player');
        }

        return createdPlayer;
    };

    const getActorMember = async (
        telegramChatId: number,
        actorUserId: number,
        telegram: ChatMemberReader,
        mode: RunType | 'command',
        locale: AppLocale = getDefaultAppLocale()
    ) => {
        const LL = getMessages(locale);
        const actorMember = await telegram.getChatMember(
            telegramChatId,
            actorUserId
        );

        if (actorMember.user.is_bot) {
            throw new BotUserError(
                LL.accessDenied({
                    name: formatUserName(actorMember.user)
                }),
                { silent: mode === 'auto' }
            );
        }

        return actorMember;
    };

    const getChannelAndActor = async (
        telegramChatId: number,
        actorUserId: number,
        telegram: ChatMemberReader,
        mode: RunType | 'command',
        locale: AppLocale = getDefaultAppLocale()
    ) => {
        const LL = getMessages(locale);
        const actorMember = await getActorMember(
            telegramChatId,
            actorUserId,
            telegram,
            mode,
            locale
        );

        const channel = await findChannel(telegramChatId);

        if (!channel) {
            if (mode === 'auto') {
                return {
                    channel: null,
                    actorMember
                };
            }

            throw new BotUserError(LL.hasNotData());
        }

        return {
            channel,
            actorMember
        };
    };

    const ensureChannel = async (
        telegramChatId: number,
        canResume: boolean
    ) => {
        const locale = getDefaultAppLocale();
        const currentRelease = getLatestReleaseVersion();
        const existingChannel = await findChannel(telegramChatId);

        if (existingChannel) {
            const isResuming = Boolean(existingChannel.stoppedAt) && canResume;

            await runEffect(
                isResuming
                    ? repositories.channels.resumeChannel(
                          telegramChatId,
                          currentRelease
                      )
                    : repositories.channels.markChannelRelease(
                          telegramChatId,
                          currentRelease
                      )
            );

            const channel =
                (await findChannel(telegramChatId)) ?? existingChannel;

            if (isResuming) {
                return { channel, state: 'resumed' as const };
            }

            return {
                channel,
                state: channel.stoppedAt
                    ? ('stopped' as const)
                    : ('existing' as const)
            };
        }

        const createdChannel = await runEffect(
            repositories.channels.createChannel(
                telegramChatId,
                currentRelease,
                locale
            )
        );

        if (!createdChannel) {
            throw new Error('Failed to create channel');
        }

        return { channel: createdChannel, state: 'created' as const };
    };

    const joinChannel = async (
        telegramChatId: number,
        user: User,
        locale: AppLocale = getDefaultAppLocale()
    ) => {
        const LL = getMessages(locale);
        const channel = await findChannel(telegramChatId);

        if (!channel) {
            throw new BotUserError(LL.hasNotData());
        }

        const player = await findOrCreatePlayer(user);
        const existingMember = await runEffect(
            repositories.channelMembers.findMember(channel.id, player.id)
        );

        if (!existingMember) {
            const member = await runEffect(
                repositories.channelMembers.createMember(channel.id, player.id)
            );

            if (!member) {
                throw new Error('Failed to create channel member');
            }

            return {
                player,
                state: 'joined' as const
            };
        }

        if (existingMember.isActive) {
            return {
                player,
                state: 'already-active' as const
            };
        }

        await runEffect(
            repositories.channelMembers.updateMemberState(existingMember.id, {
                isActive: true,
                isAutoJoined: true
            })
        );

        return {
            player,
            state: 'reactivated' as const
        };
    };

    const leaveChannel = async (
        telegramChatId: number,
        user: User,
        locale: AppLocale = getDefaultAppLocale()
    ) => {
        const LL = getMessages(locale);
        const channel = await findChannel(telegramChatId);

        if (!channel) {
            throw new BotUserError(LL.hasNotData());
        }

        const player = await runEffect(
            repositories.players.findPlayerByTelegramUserId(user.id)
        );

        if (!player) {
            throw new BotUserError(LL.hasNotData());
        }

        const member = await runEffect(
            repositories.channelMembers.findMember(channel.id, player.id)
        );

        if (!member?.isActive) {
            throw new BotUserError(
                LL.alreadyLeave({
                    name: formatUserName(user)
                })
            );
        }

        await runEffect(
            repositories.channelMembers.updateMemberState(member.id, {
                isActive: false,
                isAutoJoined: false
            })
        );

        return {
            player,
            state: 'left' as const
        };
    };

    const reconcileActivePlayers = async (
        telegramChatId: number,
        channelId: number,
        telegram: ChatMemberReader,
        mode: RunType | 'command',
        locale: AppLocale
    ) => {
        const rows = await runEffect(
            repositories.channelMembers.listMembersForChannel(channelId)
        );
        const activePlayers: ActivePlayer[] = [];

        for (const row of rows) {
            let telegramMember: ChatMember;

            try {
                telegramMember = await telegram.getChatMember(
                    telegramChatId,
                    row.player.telegramUserId
                );
            } catch (error) {
                if (isDefinitiveMissingMemberError(error)) {
                    continue;
                }

                console.error(
                    JSON.stringify({
                        event: 'chat_member_lookup_failed',
                        errorType: getErrorType(error),
                        errorCode: getTelegramErrorCode(error),
                        mode
                    })
                );

                throw new BotUserError(getMessages(locale).error(), {
                    silent: mode === 'auto'
                });
            }

            const displayName = formatUserName(telegramMember.user);

            if (isInactiveTelegramMember(telegramMember.status, displayName)) {
                if (row.member.isActive) {
                    await runEffect(
                        repositories.channelMembers.updateMemberState(
                            row.member.id,
                            {
                                isActive: false
                            }
                        )
                    );
                }

                continue;
            }

            if (!row.member.isActive && !row.member.isAutoJoined) {
                continue;
            }

            if (!row.member.isActive && row.member.isAutoJoined) {
                await runEffect(
                    repositories.channelMembers.updateMemberState(
                        row.member.id,
                        {
                            isActive: true
                        }
                    )
                );
                row.member.isActive = true;
            }

            const refreshedName = formatUserName(telegramMember.user, 'name');

            if (row.player.displayName !== refreshedName) {
                await runEffect(
                    repositories.players.updateDisplayName(
                        row.player.id,
                        refreshedName
                    )
                );
                row.player.displayName = refreshedName;
            }

            activePlayers.push({
                member: row.member,
                player: row.player,
                telegramMember
            });
        }

        return activePlayers;
    };

    const resetChannelRun = async (channelId: number) => {
        await runEffect(repositories.channels.resetChannelRun(channelId));
    };

    const getPrintablePlayers = async (
        telegramChatId: number,
        channelId: number,
        telegram: ChatMemberReader,
        list: 'all' | 'top',
        locale: AppLocale = getDefaultAppLocale()
    ) => {
        const LL = getMessages(locale);
        const memberships = await runEffect(
            repositories.channels.listChannelMembers(channelId)
        );

        if (!memberships.length) {
            throw new BotUserError(LL.playersNotFound());
        }

        const activePlayers = await reconcileActivePlayers(
            telegramChatId,
            channelId,
            telegram,
            'command',
            locale
        );
        const printablePlayers = getSortedPrintablePlayers(activePlayers, list);

        if (!printablePlayers.length) {
            throw new BotUserError(LL.playersWithScoresNotFound());
        }

        return printablePlayers;
    };

    const getRunEta = (runDate: Date, lastVoteAt: Date | null) => {
        if (!lastVoteAt) {
            return 0;
        }

        return (
            24 -
            Math.floor(
                (runDate.getTime() - lastVoteAt.getTime()) / 1000 / 60 / 60
            )
        );
    };

    const runVote = async (
        telegramChatId: number,
        actorUserId: number,
        runDate: Date,
        telegram: ChatMemberReader,
        type: RunType,
        sudo = false,
        locale: AppLocale = getDefaultAppLocale()
    ) => {
        const LL = getMessages(locale);
        const { channel, actorMember } = await getChannelAndActor(
            telegramChatId,
            actorUserId,
            telegram,
            type,
            locale
        );

        if (!channel) {
            throw new BotUserError(LL.hasNotData(), { silent: true });
        }

        if (channel.stoppedAt) {
            throw new BotUserError(LL.gameStopped(), {
                silent: type === 'auto'
            });
        }

        const channelMembers = await runEffect(
            repositories.channels.listChannelMembers(channel.id)
        );

        if (!channelMembers.length && type === 'manual') {
            throw new BotUserError(LL.playersNotFound());
        }

        if (type === 'auto' && !channel.lastVoteAt) {
            throw new BotUserError(LL.hasNotData(), { silent: true });
        }

        if (type === 'manual' && sudo && !isAdmin(actorMember)) {
            throw new BotUserError(
                LL.sudoRun({
                    name: formatUserName(actorMember.user)
                })
            );
        }

        const eta = getRunEta(runDate, channel.lastVoteAt);

        if (type === 'manual' && eta > 0 && !sudo) {
            throw new BotUserError(
                LL.errorRunEta({
                    hours: eta,
                    label: getHourLabel(eta, locale)
                }),
                { html: true }
            );
        }

        if (type === 'auto' && eta > 0) {
            throw new BotUserError(LL.hasNotData(), { silent: true });
        }

        const activePlayers = await reconcileActivePlayers(
            telegramChatId,
            channel.id,
            telegram,
            type,
            locale
        );

        if (!activePlayers.length) {
            if (type === 'auto') {
                throw new BotUserError(LL.hasNotData(), { silent: true });
            }

            await resetChannelRun(channel.id);

            throw new BotUserError(LL.playersNotFound());
        }

        if (activePlayers.length < 2) {
            if (type === 'auto') {
                throw new BotUserError(LL.hasNotData(), { silent: true });
            }

            await resetChannelRun(channel.id);

            throw new BotUserError(LL.playersNotEnough());
        }

        const winner =
            activePlayers[randomInt(0, activePlayers.length - 1)] ??
            activePlayers[0];

        if (!winner) {
            throw new Error('No winner candidate was selected');
        }

        let claimedChannel = channel;
        let ownsRunClaim = false;

        if (!sudo) {
            const claim = await runEffect(
                repositories.channels.claimChannelRun(
                    channel.id,
                    channel.lastVoteAt,
                    runDate
                )
            );

            if (!claim) {
                if (type === 'auto') {
                    throw new BotUserError(LL.hasNotData(), { silent: true });
                }

                const hours = 24;

                throw new BotUserError(
                    LL.errorRunEta({
                        hours,
                        label: getHourLabel(hours, locale)
                    }),
                    { html: true }
                );
            }

            claimedChannel = claim;
            ownsRunClaim = true;
        }

        let incrementedWinner: ChannelMemberRow;

        try {
            const incrementedMember = await runEffect(
                repositories.channelMembers.incrementMemberScore(
                    winner.member.id
                )
            );

            if (!incrementedMember) {
                throw new Error('Failed to increment winner score');
            }

            incrementedWinner = incrementedMember;
        } catch (error) {
            if (ownsRunClaim) {
                try {
                    await runEffect(
                        repositories.channels.restoreClaimedChannelRun(
                            channel.id,
                            runDate,
                            channel.lastVoteAt
                        )
                    );
                } catch (restoreError) {
                    console.error(
                        JSON.stringify({
                            event: 'channel_run_claim_restore_failed',
                            errorType: getErrorType(restoreError)
                        })
                    );
                }
            }

            throw error;
        }

        winner.member = incrementedWinner;

        try {
            await runEffect(
                repositories.voteWins.recordWin({
                    channelId: channel.id,
                    playerId: winner.player.id,
                    wonAt: runDate,
                    mode: sudo ? 'sudo' : type,
                    eligibleCount: activePlayers.length
                })
            );
        } catch (error) {
            console.error(
                JSON.stringify({
                    event: 'vote_win_record_failed',
                    errorType: getErrorType(error)
                })
            );
        }

        if (sudo) {
            await runEffect(
                repositories.channels.touchChannelRun(channel.id, runDate)
            );
        }

        const printablePlayers = getSortedPrintablePlayers(
            activePlayers,
            'top'
        );

        return {
            channel: claimedChannel,
            printablePlayers,
            winner,
            eligibleCount: activePlayers.length
        };
    };

    const loadChannelSnapshot = async (channel: ChannelRow) => {
        const [memberRows, winRows] = await Promise.all([
            runEffect(
                repositories.channelMembers.listMembersForChannel(channel.id)
            ),
            runEffect(repositories.voteWins.listWinsForChannel(channel.id))
        ]);
        const payload = buildChannelSnapshotPayload(
            channel,
            memberRows,
            winRows
        );
        const serialized = serializeChannelSnapshotPayload(payload);
        const estimatedStatements = estimateChannelSnapshotRestoreStatements(
            payload.members.length,
            payload.voteWins.length
        );

        return {
            text: serialized.text,
            bytes: serialized.bytes,
            estimatedStatements,
            exceedsLimits:
                serialized.bytes > channelSnapshotPayloadMaxBytes ||
                estimatedStatements > channelSnapshotRestoreMaxStatements,
            memberPlayerIds: memberRows.map(row => {
                return row.player.id;
            })
        };
    };

    const readChannelSnapshot = async (
        channel: ChannelRow,
        locale: AppLocale
    ) => {
        const snapshot = await loadChannelSnapshot(channel);

        if (snapshot.exceedsLimits) {
            console.error(
                JSON.stringify({
                    event: 'channel_snapshot_too_large',
                    bytes: snapshot.bytes,
                    estimatedStatements: snapshot.estimatedStatements
                })
            );

            throw new BotUserError(getMessages(locale).snapshotTooLarge());
        }

        return snapshot;
    };

    const buildSnapshotRow = (
        telegramChatId: number,
        reason: ChannelSnapshotReason,
        payload: string,
        now: Date
    ): NewChannelSnapshot => {
        return {
            telegramChatId,
            reason,
            payload,
            createdAt: now,
            expiresAt: new Date(
                now.getTime() + channelSnapshotRetentionMilliseconds
            )
        };
    };

    const resetScores = async (
        telegramChatId: number,
        locale: AppLocale = getDefaultAppLocale(),
        now = new Date()
    ) => {
        const LL = getMessages(locale);
        const channel = await findChannel(telegramChatId);

        if (!channel) {
            throw new BotUserError(LL.hasNotData());
        }

        const memberships = await runEffect(
            repositories.channels.listChannelMembers(channel.id)
        );

        if (!memberships.length) {
            throw new BotUserError(LL.playersNotFound());
        }

        const { text } = await readChannelSnapshot(channel, locale);

        await runEffect(
            repositories.channelSnapshots.resetChannelWithSnapshot({
                channelId: channel.id,
                snapshot: buildSnapshotRow(telegramChatId, 'reset', text, now)
            })
        );
    };

    const stopChannel = async (
        telegramChatId: number,
        locale: AppLocale = getDefaultAppLocale(),
        now = new Date()
    ) => {
        const LL = getMessages(locale);
        const channel = await findChannel(telegramChatId);

        if (!channel) {
            throw new BotUserError(LL.hasNotData());
        }

        if (channel.stoppedAt) {
            throw new BotUserError(LL.alreadyStop());
        }

        await runEffect(
            repositories.channels.markChannelStopped(channel.id, now)
        );
    };

    const forgetChannel = async (
        telegramChatId: number,
        locale: AppLocale = getDefaultAppLocale(),
        now = new Date()
    ) => {
        const LL = getMessages(locale);
        const channel = await findChannel(telegramChatId);

        if (!channel) {
            throw new BotUserError(LL.hasNotData());
        }

        const { text, memberPlayerIds } = await readChannelSnapshot(
            channel,
            locale
        );

        await runEffect(
            repositories.channelSnapshots.forgetChannelWithSnapshot({
                channelId: channel.id,
                snapshot: buildSnapshotRow(telegramChatId, 'forget', text, now)
            })
        );
        await runEffect(
            repositories.players.deleteOrphanedPlayers(memberPlayerIds)
        );
    };

    const restoreChannel = async (
        telegramChatId: number,
        locale: AppLocale = getDefaultAppLocale(),
        now = new Date()
    ) => {
        const LL = getMessages(locale);
        const latestSnapshot = await runEffect(
            repositories.channelSnapshots.findLatestActiveSnapshot(
                telegramChatId,
                now
            )
        );

        if (!latestSnapshot) {
            throw new BotUserError(LL.restoreNotFound());
        }

        const payload = parseChannelSnapshotPayload(latestSnapshot.payload);

        if (!payload || payload.channel.telegramChatId !== telegramChatId) {
            console.error(
                JSON.stringify({
                    event: 'channel_snapshot_invalid',
                    reason: latestSnapshot.reason
                })
            );

            throw new BotUserError(LL.error());
        }

        const currentChannel = await findChannel(telegramChatId);
        const currentSnapshot = currentChannel
            ? await loadChannelSnapshot(currentChannel)
            : null;
        const safetySnapshotText =
            currentSnapshot && !currentSnapshot.exceedsLimits
                ? currentSnapshot.text
                : null;

        if (currentSnapshot?.exceedsLimits) {
            console.error(
                JSON.stringify({
                    event: 'channel_restore_safety_snapshot_skipped',
                    bytes: currentSnapshot.bytes,
                    estimatedStatements: currentSnapshot.estimatedStatements
                })
            );
        }

        await runEffect(
            repositories.channelSnapshots.restoreChannelFromSnapshot({
                telegramChatId,
                payload,
                releaseVersion: getLatestReleaseVersion(),
                safetySnapshot:
                    safetySnapshotText === null
                        ? null
                        : buildSnapshotRow(
                              telegramChatId,
                              'restore',
                              safetySnapshotText,
                              now
                          ),
                now
            })
        );

        if (currentSnapshot) {
            await runEffect(
                repositories.players.deleteOrphanedPlayers(
                    currentSnapshot.memberPlayerIds
                )
            );
        }

        return {
            locale:
                normalizeAppLocale(payload.channel.language) ??
                getDefaultAppLocale()
        };
    };

    const cleanupInactiveChannels = async (cutoff: Date) => {
        assertGlobalCleanupAllowed(env);

        const candidatePlayers = await runEffect(
            repositories.channels.findInactiveChannelPlayerIds(cutoff)
        );
        const deletedChannels = await runEffect(
            repositories.channels.deleteInactiveChannels(cutoff)
        );
        await runEffect(
            repositories.players.deleteOrphanedPlayers(
                candidatePlayers.map(candidate => candidate.playerId)
            )
        );

        return deletedChannels.length;
    };

    const getStats = async () => {
        const [channelsCount, playersCount] = await Promise.all([
            runEffect(repositories.channels.countChannels()),
            runEffect(repositories.players.countPlayers())
        ]);

        return {
            channelsCount,
            playersCount
        };
    };

    const setChannelLocale = async (
        telegramChatId: number,
        locale: AppLocale,
        currentLocale: AppLocale = getDefaultAppLocale()
    ) => {
        const channel = await findChannel(telegramChatId);

        if (!channel) {
            throw new BotUserError(getMessages(currentLocale).hasNotData());
        }

        await runEffect(
            repositories.channels.updateChannelLanguage(telegramChatId, locale)
        );

        return (
            (await findChannel(telegramChatId)) ?? {
                ...channel,
                language: locale
            }
        );
    };

    const getChannelDebugInfo = async (
        telegramChatId: number,
        actorUserId: number
    ): Promise<ChannelDebugInfo> => {
        const [channel, latestSnapshot, actorPlayer] = await Promise.all([
            findChannel(telegramChatId),
            runEffect(
                repositories.channelSnapshots.findLatestActiveSnapshotSummary(
                    telegramChatId,
                    new Date()
                )
            ),
            runEffect(
                repositories.players.findPlayerByTelegramUserId(actorUserId)
            )
        ]);

        if (!channel) {
            return {
                channel: null,
                memberCounts: { total: 0, active: 0, autoJoined: 0 },
                actor: { player: null, member: null },
                latestWin: null,
                latestSnapshot
            };
        }

        const [memberCounts, latestWin, actorMember] = await Promise.all([
            runEffect(repositories.channels.countChannelMembers(channel.id)),
            runEffect(
                repositories.voteWins.findLatestWinForChannel(channel.id)
            ),
            actorPlayer
                ? runEffect(
                      repositories.channelMembers.findMember(
                          channel.id,
                          actorPlayer.id
                      )
                  )
                : null
        ]);

        return {
            channel,
            memberCounts,
            actor: {
                player: actorPlayer ? { id: actorPlayer.id } : null,
                member: actorMember
                    ? {
                          isActive: actorMember.isActive,
                          isAutoJoined: actorMember.isAutoJoined,
                          score: actorMember.score
                      }
                    : null
            },
            latestWin: latestWin
                ? {
                      wonAt: latestWin.wonAt,
                      mode: latestWin.mode,
                      eligibleCount: latestWin.eligibleCount
                  }
                : null,
            latestSnapshot
        };
    };

    return {
        ensureChannel,
        getChannelLocale,
        getChannelDebugInfo,
        setChannelLocale,
        getChannelAndActor,
        getActorMember,
        joinChannel,
        leaveChannel,
        getPrintablePlayers,
        runVote,
        resetScores,
        stopChannel,
        forgetChannel,
        restoreChannel,
        cleanupInactiveChannels,
        getStats
    };
};
