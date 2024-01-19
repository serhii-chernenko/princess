const { message } = require('telegraf/filters');
const bot = require('../bot');
const isForwarded = require('../helpers/forward');
const { getTime } = require('../helpers/intl');
const run = require('../helpers/run');

bot.on(message('text'), async ctx => {
    try {
        if (ctx.message?.text?.match('/') || isForwarded(ctx)) {
            return ctx;
        }

        console.log('message.js', getTime(), ctx.message);
        await run(ctx);
    } catch (error) {
        if (error?.type === 'auto') {
            return ctx;
        }

        console.log(error);
    }
});

module.exports = bot;
