import type { TranslationFunctions } from '../../i18n/i18n-types';
import type { channelSnapshots, channels, voteWins } from '../../db/schema';
import { escapeHtml } from '../utils/strings';

type ChannelRow = typeof channels.$inferSelect;
type VoteWinRow = typeof voteWins.$inferSelect;
type ChannelSnapshotRow = typeof channelSnapshots.$inferSelect;

export interface ChannelDebugInfo {
    channel: ChannelRow | null;
    memberCounts: {
        total: number;
        active: number;
        autoJoined: number;
    };
    actor: {
        player: { id: number } | null;
        member: {
            isActive: boolean;
            isAutoJoined: boolean;
            score: number;
        } | null;
    };
    latestWin: Pick<VoteWinRow, 'wonAt' | 'mode' | 'eligibleCount'> | null;
    latestSnapshot: Pick<
        ChannelSnapshotRow,
        'reason' | 'createdAt' | 'expiresAt'
    > | null;
}

export interface DebugReport {
    chatId: number;
    chatType: string;
    userId: number;
    environment: string;
    currentReleaseVersion: string;
    liveStatuses: {
        user: string | null;
        bot: string | null;
    } | null;
    info: ChannelDebugInfo | null;
}

const EMPTY_VALUE = '-';

const formatCode = (value: string | number) => {
    return `<code>${escapeHtml(String(value))}</code>`;
};

const formatLine = (label: string, value: string | number) => {
    return `${escapeHtml(label)}: ${formatCode(value)}`;
};

const formatDate = (value: Date | null) => {
    if (!value) {
        return EMPTY_VALUE;
    }

    return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

const formatSection = (title: string, lines: string[]) => {
    return [`<strong>${escapeHtml(title)}</strong>`, ...lines].join('\n');
};

export const renderDebugReport = (
    report: DebugReport,
    LL: TranslationFunctions
) => {
    const labels = LL.debug;
    const formatYesNo = (value: boolean) => {
        return value ? labels.yes() : labels.no();
    };
    const intro = escapeHtml(labels.intro());
    const formatLiveStatus = (status: string | null) => {
        return status ?? labels.unavailable();
    };

    const chatLines = [
        formatLine(labels.chatId(), report.chatId),
        formatLine(labels.chatType(), report.chatType),
        formatLine(labels.userId(), report.userId)
    ];

    if (report.liveStatuses) {
        chatLines.push(
            formatLine(
                labels.yourStatus(),
                formatLiveStatus(report.liveStatuses.user)
            ),
            formatLine(
                labels.botStatus(),
                formatLiveStatus(report.liveStatuses.bot)
            )
        );
    }

    const sections = [
        formatSection(labels.chatSection(), chatLines),
        formatSection(labels.botSection(), [
            formatLine(labels.environment(), report.environment),
            formatLine(labels.currentRelease(), report.currentReleaseVersion)
        ])
    ];
    const { info } = report;

    if (!info) {
        sections.push(escapeHtml(labels.noGroupData()), intro);

        return sections.join('\n\n');
    }

    const { channel, memberCounts, actor, latestWin, latestSnapshot } = info;

    if (!channel) {
        sections.push(
            formatSection(labels.gameSection(), [
                formatLine(labels.registered(), labels.no())
            ])
        );
    } else {
        sections.push(
            formatSection(labels.gameSection(), [
                formatLine(labels.registered(), labels.yes()),
                formatLine(labels.channelId(), channel.id),
                formatLine(labels.language(), channel.language),
                formatLine(labels.storedRelease(), channel.releaseVersion),
                formatLine(labels.pausedAt(), formatDate(channel.stoppedAt)),
                formatLine(labels.createdAt(), formatDate(channel.createdAt)),
                formatLine(labels.lastVoteAt(), formatDate(channel.lastVoteAt)),
                formatLine(
                    labels.storedBotStatus(),
                    channel.botAdminStatus ?? EMPTY_VALUE
                ),
                formatLine(
                    labels.storedBotStatusCheckedAt(),
                    formatDate(channel.botAdminCheckedAt)
                )
            ]),
            formatSection(labels.playersSection(), [
                formatLine(labels.playersTotal(), memberCounts.total),
                formatLine(labels.playersActive(), memberCounts.active),
                formatLine(labels.playersAutoJoined(), memberCounts.autoJoined),
                ...(actor.player
                    ? [formatLine(labels.yourPlayerId(), actor.player.id)]
                    : []),
                ...(actor.member
                    ? [
                          formatLine(
                              labels.yourActive(),
                              formatYesNo(actor.member.isActive)
                          ),
                          formatLine(
                              labels.yourAutoJoined(),
                              formatYesNo(actor.member.isAutoJoined)
                          ),
                          formatLine(labels.yourScore(), actor.member.score)
                      ]
                    : [formatCode(labels.notInGame())])
            ]),
            formatSection(
                labels.lastWinSection(),
                latestWin
                    ? [
                          formatLine(
                              labels.wonAt(),
                              formatDate(latestWin.wonAt)
                          ),
                          formatLine(labels.winMode(), latestWin.mode),
                          formatLine(
                              labels.eligibleCount(),
                              latestWin.eligibleCount
                          )
                      ]
                    : [formatCode(EMPTY_VALUE)]
            )
        );
    }

    sections.push(
        formatSection(
            labels.backupSection(),
            latestSnapshot
                ? [
                      formatLine(labels.backupReason(), latestSnapshot.reason),
                      formatLine(
                          labels.backupCreatedAt(),
                          formatDate(latestSnapshot.createdAt)
                      ),
                      formatLine(
                          labels.backupExpiresAt(),
                          formatDate(latestSnapshot.expiresAt)
                      )
                  ]
                : [formatCode(EMPTY_VALUE)]
        )
    );

    sections.push(intro);

    return sections.join('\n\n');
};
