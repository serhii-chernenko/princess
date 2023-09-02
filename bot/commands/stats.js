const bot = require('../bot');
const Channel = require('../models/channel');
const Player = require('../models/player');
const cleanDB = require('../helpers/clean-db');
const messages = require('../i18n/messages');
const isForwarded = require('../helpers/forward');

bot.command('stats', async ctx => {
    try {
        if (isForwarded(ctx)) {
            return ctx;
        }

        await cleanDB();

        const channels = await Channel.find().count();
        const players = await Player.find().count();

        await ctx.replyWithHTML(
            messages.stats
                .replace('%groups', channels.toString())
                .replace('%players', players.toString())
                .replace('%youtube', process.env.YT_CHANNEL)
                .replace('%twitter', process.env.AUTHOR_TWITTER_LINK)
                .replace('%tgChannel', process.env.TG_CHANNEL)
                .replace('%mail', process.env.MAIL)
        );
    } catch (error) {
        console.error('stats.js', error);
        await ctx.sendMessage(error?.error ?? messages.error);
    }
});

module.exports = bot;
