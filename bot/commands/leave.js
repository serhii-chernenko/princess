const bot = require('../bot');
const Player = require('../models/player');
const Status = require('../models/status');
const getChatAndUser = require('../helpers/chat');
const returnUserName = require('../helpers/username');
const messages = require('../i18n/messages');
const isForwarded = require('../helpers/forward');

bot.command('leave', async ctx => {
    try {
        if (isForwarded(ctx)) {
            return ctx;
        }

        const {
            channel,
            member: { user }
        } = await getChatAndUser(ctx);

        if (!channel.players.length) {
            return await ctx.sendMessage(messages.hasNotData);
        }

        const player = await Player.findOne({
            entity_id: user.id
        });

        if (!player) {
            return await ctx.sendMessage(messages.hasNotData);
        }

        const status = await Status.findOne({
            channel_id: channel._id,
            player_id: player._id
        });

        if (!status?.status) {
            return await ctx.sendMessage(
                messages.alreadyLeave.replace('%s', returnUserName(user))
            );
        }

        await status.updateOne({
            status: false,
            auto: false
        });
        await ctx.sendMessage(
            messages.successLeave.replace('%s', returnUserName(user))
        );
    } catch (error) {
        console.error('leave.js', error);
        await ctx.sendMessage(error?.error ?? messages.error);
    }
});

module.exports = bot;
