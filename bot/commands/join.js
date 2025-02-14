const bot = require('../bot');
const Player = require('../models/player');
const Status = require('../models/status');
const isForwarded = require('../helpers/forward');
const getChatAndUser = require('../helpers/chat');
const join = require('../helpers/join');
const returnUserName = require('../helpers/username');
const messages = require('../i18n/messages');

bot.command('join', async ctx => {
    try {
        if (isForwarded(ctx)) {
            return ctx;
        }

        const {
            channel,
            member: { user }
        } = await getChatAndUser(ctx);

        if (!channel.players.length) {
            await join(channel, user);

            return await ctx.sendMessage(
                messages.successJoin.replace('%s', returnUserName(user))
            );
        }

        let player = await Player.findOne({
            entity_id: user.id
        });

        if (!player) {
            await join(channel, user);

            return await ctx.sendMessage(
                messages.successJoin.replace('%s', returnUserName(user))
            );
        }

        const channelAndPlayersIds = {
            channel_id: channel._id,
            player_id: player._id
        };

        let status = await Status.findOne(channelAndPlayersIds);

        if (!status) {
            status = await new Status({
                ...channelAndPlayersIds,
                status: false
            });

            await status.save();
        }

        const isPlayerExist = player
            ? !!channel.players.find(
                  channelPlayer =>
                      channelPlayer.player_id.toString() ===
                      player._id.toString()
              )
            : false;

        if (isPlayerExist && status?.status) {
            return await ctx.sendMessage(
                messages.alreadyJoin.replace('%s', returnUserName(user))
            );
        }

        await status.updateOne({
            status: true,
            auto: true
        });
        await join(channel, user);
        await ctx.sendMessage(
            messages.successJoin.replace('%s', returnUserName(user))
        );
    } catch (error) {
        console.error('join.js', error);
        await ctx.sendMessage(error?.error ?? messages.error);
    }
});

module.exports = bot;
