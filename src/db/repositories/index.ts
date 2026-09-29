import type { AppDb } from '../client';
import { createChannelMemberRepository } from './channel-member-repository';
import { createChannelRepository } from './channel-repository';
import { createPlayerRepository } from './player-repository';
import { createTelegramUpdateRepository } from './telegram-update-repository';

export const createRepositories = (db: AppDb) => {
    return {
        channels: createChannelRepository(db),
        players: createPlayerRepository(db),
        channelMembers: createChannelMemberRepository(db),
        telegramUpdates: createTelegramUpdateRepository(db)
    };
};
