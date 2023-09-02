const bot = require('../bot');
const releasesToPost = require('../helpers/releases');
const messages = require('../i18n/messages');
const isForwarded = require('../helpers/forward');

bot.command('releases', async ctx => {
    try {
        if (isForwarded(ctx)) {
            return ctx;
        }

        await ctx.replyWithHTML(await releasesToPost());
    } catch (error) {
        console.error('releases.js', error);
        await ctx.sendMessage(error?.error ?? messages.error);
    }
});

module.exports = bot;
