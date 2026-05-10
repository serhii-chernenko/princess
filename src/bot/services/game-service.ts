import { Effect } from 'effect';
import type { ChatMember, User } from 'telegraf/types';

import { BotUserError } from '../errors';
import { getLatestReleaseVersion } from '../content/releases';
import { messages } from '../content/messages';
import {
    formatUserName,
    isInactiveTelegramMember,
    randomInt
} from '../utils/telegram';
import { createRepositories } from '../../db/repositories';
import { createDb } from '../../db/client';
import { channelMembers, players } from '../../db/schema';
import type { WorkerBindings } from '../../worker/env';

type PlayerRow = typeof players.$inferSelect;
type ChannelMemberRow = typeof channelMembers.$inferSelect;

type ActivePlayer = {
    member: ChannelMemberRow;
    player: PlayerRow;
    telegramMember: ChatMember;
};

type ChatMemberReader = {
    getChatMember(chatId: number, userId: number): Promise<ChatMember>;
};

type RunType = 'auto' | 'manual';

const runEffect = <A>(effect: Effect.Effect<A, Error>) => {
    return Effect.runPromise(effect);
};

const isAdmin = (member: ChatMember) => {
    return member.status === 'creator' || member.status === 'administrator';
};

const findHourLabel = (eta: number) => {
    return (
        (
            messages.hours as ReadonlyArray<{
                hours: number[];
                label: string;
            }>
        ).find(item => item.hours.includes(eta))?.label ?? 'годин'
    );
};

export const createGameService = (env: WorkerBindings) => {
    const db = createDb(env);
    const repositories = createRepositories(db);

    const findChannel = async (telegramChatId: number) => {
        return runEffect(
            repositories.channels.findChannelByTelegramChatId(telegramChatId)
        );
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

    const getChannelAndActor = async (
        telegramChatId: number,
        actorUserId: number,
        telegram: ChatMemberReader,
        mode: RunType | 'command'
    ) => {
        const actorMember = await telegram.getChatMember(
            telegramChatId,
            actorUserId
        );

        if (actorMember.user.is_bot) {
            throw new BotUserError(
                messages.accessDenied.replace(
                    '%s',
                    formatUserName(actorMember.user)
                )
            );
        }

        const channel = await findChannel(telegramChatId);

        if (!channel) {
            if (mode === 'auto') {
                return {
                    channel: null,
                    actorMember
                };
            }

            throw new BotUserError(messages.hasNotData);
        }

        return {
            channel,
            actorMember
        };
    };

    const ensureChannel = async (telegramChatId: number) => {
        const currentRelease = getLatestReleaseVersion();
        const existingChannel = await findChannel(telegramChatId);

        if (existingChannel) {
            await runEffect(
                repositories.channels.markChannelRelease(
                    telegramChatId,
                    currentRelease
                )
            );

            return (await findChannel(telegramChatId)) ?? existingChannel;
        }

        const createdChannel = await runEffect(
            repositories.channels.createChannel(telegramChatId, currentRelease)
        );

        if (!createdChannel) {
            throw new Error('Failed to create channel');
        }

        return createdChannel;
    };

    const joinChannel = async (telegramChatId: number, user: User) => {
        const channel = await findChannel(telegramChatId);

        if (!channel) {
            throw new BotUserError(messages.hasNotData);
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

    const leaveChannel = async (telegramChatId: number, user: User) => {
        const channel = await findChannel(telegramChatId);

        if (!channel) {
            throw new BotUserError(messages.hasNotData);
        }

        const player = await runEffect(
            repositories.players.findPlayerByTelegramUserId(user.id)
        );

        if (!player) {
            throw new BotUserError(messages.hasNotData);
        }

        const member = await runEffect(
            repositories.channelMembers.findMember(channel.id, player.id)
        );

        if (!member?.isActive) {
            throw new BotUserError(
                messages.alreadyLeave.replace('%s', formatUserName(user))
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
        list: 'all' | 'top' = 'top'
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
            } catch {
                continue;
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

            if (list !== 'top' || row.member.score > 0) {
                activePlayers.push({
                    member: row.member,
                    player: row.player,
                    telegramMember
                });
            }
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
        list: 'all' | 'top'
    ) => {
        const activePlayers = await reconcileActivePlayers(
            telegramChatId,
            channelId,
            telegram,
            list
        );

        if (!activePlayers.length) {
            throw new BotUserError(messages.playersWithScoresNotFound);
        }

        return activePlayers.sort((left, right) => {
            return right.member.score - left.member.score;
        });
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
        sudo = false
    ) => {
        const { channel, actorMember } = await getChannelAndActor(
            telegramChatId,
            actorUserId,
            telegram,
            type
        );

        if (!channel) {
            throw new BotUserError(messages.hasNotData, { silent: true });
        }

        const channelMembers = await runEffect(
            repositories.channels.listChannelMembers(channel.id)
        );

        if (!channelMembers.length && type === 'manual') {
            throw new BotUserError(messages.playersNotFound);
        }

        if (type === 'auto' && !channel.lastVoteAt) {
            throw new BotUserError(messages.hasNotData, { silent: true });
        }

        if (type === 'manual' && sudo && !isAdmin(actorMember)) {
            throw new BotUserError(
                messages.sudoRun.replace('%s', formatUserName(actorMember.user))
            );
        }

        const eta = getRunEta(runDate, channel.lastVoteAt);

        if (type === 'manual' && eta > 0 && !sudo) {
            throw new BotUserError(
                messages.errorRunEta
                    .replace('%hours', eta.toString())
                    .replace('%label', findHourLabel(eta)),
                { html: true }
            );
        }

        if (type === 'auto' && eta > 0) {
            throw new BotUserError(messages.hasNotData, { silent: true });
        }

        const activePlayers = await reconcileActivePlayers(
            telegramChatId,
            channel.id,
            telegram,
            'all'
        );

        if (!activePlayers.length) {
            await resetChannelRun(channel.id);

            if (type === 'manual') {
                throw new BotUserError(messages.playersNotFound);
            }

            throw new BotUserError(messages.hasNotData, { silent: true });
        }

        if (activePlayers.length < 2) {
            await resetChannelRun(channel.id);

            if (type === 'auto') {
                throw new BotUserError(messages.hasNotData, { silent: true });
            }

            throw new BotUserError(messages.playersNotEnough);
        }

        const winner =
            activePlayers[randomInt(0, activePlayers.length - 1)] ??
            activePlayers[0];

        if (!winner) {
            throw new Error('No winner candidate was selected');
        }

        await runEffect(
            repositories.channelMembers.updateMemberState(winner.member.id, {
                score: winner.member.score + 1
            })
        );
        await runEffect(
            repositories.channels.touchChannelRun(channel.id, runDate)
        );

        const printablePlayers = await getPrintablePlayers(
            telegramChatId,
            channel.id,
            telegram,
            'top'
        );

        return {
            channel,
            printablePlayers,
            winner
        };
    };

    const resetScores = async (telegramChatId: number) => {
        const channel = await findChannel(telegramChatId);

        if (!channel) {
            throw new BotUserError(messages.hasNotData);
        }

        const memberships = await runEffect(
            repositories.channels.listChannelMembers(channel.id)
        );

        if (!memberships.length) {
            throw new BotUserError(messages.playersNotFound);
        }

        await runEffect(
            repositories.channelMembers.resetScoresForChannel(channel.id)
        );
        await resetChannelRun(channel.id);
    };

    const deleteChannelAndOrphans = async (channelId: number) => {
        const memberships = await runEffect(
            repositories.channels.listChannelMembers(channelId)
        );
        const candidatePlayerIds = memberships.map(member => member.playerId);

        await runEffect(repositories.channels.deleteChannel(channelId));

        const orphanedPlayerIds = await runEffect(
            repositories.channelMembers.findOrphanedPlayerIds(
                candidatePlayerIds
            )
        );

        for (const playerId of orphanedPlayerIds) {
            await runEffect(repositories.players.deletePlayer(playerId));
        }
    };

    const stopChannel = async (telegramChatId: number) => {
        const channel = await findChannel(telegramChatId);

        if (!channel) {
            throw new BotUserError(messages.alreadyStop);
        }

        const memberships = await runEffect(
            repositories.channels.listChannelMembers(channel.id)
        );

        if (!memberships.length) {
            throw new BotUserError(messages.alreadyStop);
        }

        await deleteChannelAndOrphans(channel.id);
    };

    const cleanupInactiveChannels = async (cutoff: Date) => {
        const staleChannels = await runEffect(
            repositories.channels.findInactiveChannels(cutoff)
        );

        for (const channel of staleChannels) {
            await deleteChannelAndOrphans(channel.id);
        }

        return staleChannels.length;
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

    return {
        ensureChannel,
        getChannelAndActor,
        joinChannel,
        leaveChannel,
        getPrintablePlayers,
        runVote,
        resetScores,
        stopChannel,
        cleanupInactiveChannels,
        getStats
    };
};
