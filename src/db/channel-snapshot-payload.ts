import type { channelMembers, channels, players, voteWins } from './schema';

export const channelSnapshotRetentionMilliseconds = 7 * 24 * 60 * 60 * 1000;
export const channelSnapshotPayloadMaxBytes = 1_900_000;
export const channelSnapshotPayloadVersion = 1;
export const channelSnapshotRestoreMaxStatements = 900;
export const channelSnapshotMaxPerChat = 5;

const restorePlayerRowsPerStatement = 25;
const restoreMemberRowsPerStatement = 14;
const restoreWinRowsPerStatement = 20;
const restoreFixedStatementCount = 6;

const voteWinModeValues = ['auto', 'manual', 'sudo'];

export interface ChannelSnapshotPayload {
    version: 1;
    channel: {
        telegramChatId: number;
        language: string;
        releaseVersion: string;
        lastVoteAt: number | null;
        stoppedAt: number | null;
        createdAt: number;
    };
    members: Array<{
        telegramUserId: number;
        displayName: string;
        score: number;
        isActive: boolean;
        isAutoJoined: boolean;
        createdAt: number;
        updatedAt: number;
    }>;
    voteWins: Array<{
        telegramUserId: number;
        wonAt: number;
        mode: 'auto' | 'manual' | 'sudo';
        eligibleCount: number;
    }>;
}

type ChannelRow = typeof channels.$inferSelect;

type MemberRow = {
    member: typeof channelMembers.$inferSelect;
    player: typeof players.$inferSelect;
};

type WinRow = {
    win: typeof voteWins.$inferSelect;
    telegramUserId: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

const isInteger = (value: unknown): value is number => {
    return typeof value === 'number' && Number.isInteger(value);
};

const isNullableInteger = (value: unknown): value is number | null => {
    return value === null || isInteger(value);
};

const isChannelPayload = (value: unknown) => {
    return (
        isRecord(value) &&
        isInteger(value.telegramChatId) &&
        typeof value.language === 'string' &&
        typeof value.releaseVersion === 'string' &&
        isNullableInteger(value.lastVoteAt) &&
        isNullableInteger(value.stoppedAt) &&
        isInteger(value.createdAt)
    );
};

const isMemberPayload = (value: unknown) => {
    return (
        isRecord(value) &&
        isInteger(value.telegramUserId) &&
        typeof value.displayName === 'string' &&
        isInteger(value.score) &&
        value.score >= 0 &&
        typeof value.isActive === 'boolean' &&
        typeof value.isAutoJoined === 'boolean' &&
        isInteger(value.createdAt) &&
        isInteger(value.updatedAt)
    );
};

const isVoteWinPayload = (value: unknown) => {
    return (
        isRecord(value) &&
        isInteger(value.telegramUserId) &&
        isInteger(value.wonAt) &&
        typeof value.mode === 'string' &&
        voteWinModeValues.includes(value.mode) &&
        isInteger(value.eligibleCount) &&
        value.eligibleCount >= 2
    );
};

const isChannelSnapshotPayload = (
    value: unknown
): value is ChannelSnapshotPayload => {
    return (
        isRecord(value) &&
        value.version === channelSnapshotPayloadVersion &&
        isChannelPayload(value.channel) &&
        Array.isArray(value.members) &&
        value.members.every(isMemberPayload) &&
        Array.isArray(value.voteWins) &&
        value.voteWins.every(isVoteWinPayload)
    );
};

export const buildChannelSnapshotPayload = (
    channel: ChannelRow,
    memberRows: MemberRow[],
    winRows: WinRow[]
): ChannelSnapshotPayload => {
    const memberUserIds = new Set(
        memberRows.map(row => {
            return row.player.telegramUserId;
        })
    );

    return {
        version: channelSnapshotPayloadVersion,
        channel: {
            telegramChatId: channel.telegramChatId,
            language: channel.language,
            releaseVersion: channel.releaseVersion,
            lastVoteAt: channel.lastVoteAt?.getTime() ?? null,
            stoppedAt: channel.stoppedAt?.getTime() ?? null,
            createdAt: channel.createdAt.getTime()
        },
        members: memberRows.map(({ member, player }) => {
            return {
                telegramUserId: player.telegramUserId,
                displayName: player.displayName,
                score: member.score,
                isActive: member.isActive,
                isAutoJoined: member.isAutoJoined,
                createdAt: member.createdAt.getTime(),
                updatedAt: member.updatedAt.getTime()
            };
        }),
        voteWins: winRows
            .filter(({ telegramUserId }) => {
                return memberUserIds.has(telegramUserId);
            })
            .map(({ win, telegramUserId }) => {
                return {
                    telegramUserId,
                    wonAt: win.wonAt.getTime(),
                    mode: win.mode,
                    eligibleCount: win.eligibleCount
                };
            })
    };
};

export const estimateChannelSnapshotRestoreStatements = (
    memberCount: number,
    winCount: number
) => {
    return (
        Math.ceil(memberCount / restorePlayerRowsPerStatement) +
        Math.ceil(memberCount / restoreMemberRowsPerStatement) +
        Math.ceil(winCount / restoreWinRowsPerStatement) +
        restoreFixedStatementCount
    );
};

export const serializeChannelSnapshotPayload = (
    payload: ChannelSnapshotPayload
) => {
    const text = JSON.stringify(payload);

    return {
        text,
        bytes: new TextEncoder().encode(text).byteLength
    };
};

export const parseChannelSnapshotPayload = (
    text: string
): ChannelSnapshotPayload | null => {
    try {
        const parsed: unknown = JSON.parse(text);

        return isChannelSnapshotPayload(parsed) ? parsed : null;
    } catch {
        return null;
    }
};
