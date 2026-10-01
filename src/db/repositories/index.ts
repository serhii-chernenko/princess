import type { AppDb } from '../client';
import { createChannelMemberRepository } from './channel-member-repository';
import { createChannelRepository } from './channel-repository';
import { createChannelSnapshotRepository } from './channel-snapshot-repository';
import { createPlayerRepository } from './player-repository';
import { createReleaseAnnouncementRepository } from './release-announcement-repository';
import { createTelegramUpdateRepository } from './telegram-update-repository';
import { createVoteWinRepository } from './vote-win-repository';

export const createRepositories = (db: AppDb) => {
    return {
        channels: createChannelRepository(db),
        players: createPlayerRepository(db),
        channelMembers: createChannelMemberRepository(db),
        channelSnapshots: createChannelSnapshotRepository(db),
        releaseAnnouncements: createReleaseAnnouncementRepository(db),
        telegramUpdates: createTelegramUpdateRepository(db),
        voteWins: createVoteWinRepository(db)
    };
};
