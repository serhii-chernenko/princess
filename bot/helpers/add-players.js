const Player = require('../models/player');
const Status = require('../models/status');
const Score = require('../models/score');
const returnUserName = require('./username');

const isInactivePlayer = (status, name) => {
    return status === 'left' || status === 'kicked' || name === '@';
};

module.exports = async (ctx, channel, list = 'top', activePlayers = []) => {
    for await (const channelPlayer of channel.players) {
        let player = await Player.findById(channelPlayer.player_id);
        const channelAndPlayerIds = {
            channel_id: channel._id,
            player_id: player._id
        };
        const status = await Status.findOne(channelAndPlayerIds);

        let member;

        try {
            member = await ctx.getChatMember(player.entity_id);
        } catch (error) {
            continue;
        }

        if (isInactivePlayer(member.status, returnUserName(member.user))) {
            if (status?.status) {
                await status.updateOne({
                    status: false
                });
            }

            continue;
        } else {
            if (!status?.status && !status?.auto) {
                // Don't update status if a user manually left the game
                // And don't add the player to the list
                continue;
            } else if (!status?.status && status?.auto) {
                await status.updateOne({
                    status: true
                });
            }
        }

        const score = await Score.findOne(channelAndPlayerIds);

        if ((list === 'top' && score?.score) || list !== 'top') {
            await player.updateOne({
                name: returnUserName(member.user, 'name')
            });
            player = await Player.findById(player._id);

            activePlayers.push({
                member,
                player,
                status,
                score
            });
        }
    }

    return activePlayers;
};
