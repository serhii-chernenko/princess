const {
    Scenes: { BaseScene }
} = require('telegraf');
const { message } = require('telegraf/filters');
const messages = require('../i18n/messages');
const returnUserName = require('../helpers/username');
const isForwarded = require('../helpers/forward');

const proposalScene = new BaseScene('proposal');

proposalScene.enter(async ctx => {
    return await ctx.sendMessage(messages.proposalEnter);
});
proposalScene.leave(async ctx => {
    return await ctx.sendMessage(messages.proposalLeave);
});

proposalScene.on(message('text'), async ctx => {
    try {
        if (ctx?.update?.message?.text?.match('/') || isForwarded(ctx)) {
            return ctx;
        }

        await ctx.telegram.sendMessage(
            process.env.ADMIN_ID,
            `${ctx.update.message.text}\n${messages.from.replace(
                '%s',
                returnUserName(ctx.update.message.from)
            )}`
        );
        await ctx.scene.leave();
    } catch (error) {
        await ctx.sendMessage(error?.error ?? messages.error);
    }
});

module.exports = proposalScene;
