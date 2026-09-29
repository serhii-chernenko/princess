import { defineRelations } from 'drizzle-orm';

import * as schema from './schema';

export const relations = defineRelations(schema, r => {
    return {
        channels: {
            members: r.many.channelMembers({
                from: r.channels.id,
                to: r.channelMembers.channelId
            }),
            players: r.many.players({
                from: r.channels.id.through(r.channelMembers.channelId),
                to: r.players.id.through(r.channelMembers.playerId)
            }),
            releaseAnnouncements: r.many.releaseAnnouncements({
                from: r.channels.id,
                to: r.releaseAnnouncements.channelId
            })
        },
        players: {
            memberships: r.many.channelMembers({
                from: r.players.id,
                to: r.channelMembers.playerId
            }),
            channels: r.many.channels({
                from: r.players.id.through(r.channelMembers.playerId),
                to: r.channels.id.through(r.channelMembers.channelId)
            })
        },
        releaseAnnouncements: {
            channel: r.one.channels({
                from: r.releaseAnnouncements.channelId,
                to: r.channels.id,
                optional: false
            })
        },
        channelMembers: {
            channel: r.one.channels({
                from: r.channelMembers.channelId,
                to: r.channels.id,
                optional: false
            }),
            player: r.one.players({
                from: r.channelMembers.playerId,
                to: r.players.id,
                optional: false
            })
        }
    };
});
