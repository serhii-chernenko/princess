const getChatAndUser = require('./chat');
const isAdmin = require('../helpers/admin');
const returnUserName = require('../helpers/username');
const dailyVote = require('./vote');
const messages = require('../i18n/messages');

module.exports = async (ctx, type = 'auto', sudo = false) => {
    const date = new Date(ctx.update.message.date * 1000);
    const { channel, member } = await getChatAndUser(ctx);

    if (!channel.players.length && type === 'manual') {
        return Promise.reject({
            error: messages.playersNotFound
        });
    } else if (type === 'auto' && !channel.updated_at) {
        return Promise.reject({ type });
    }

    if (type === 'manual' && sudo) {
        if (await isAdmin(member)) {
            return await dailyVote(ctx, channel, date, type);
        }

        return Promise.reject({
            error: messages.sudoRun.replace('%s', returnUserName(member.user))
        });
    }

    const lastRun = new Date(channel.updated_at);
    const eta = 24 - Math.floor((date - lastRun) / 1000 / 60 / 60);

    if (type === 'manual' && eta > 0) {
        const { label } = messages.hours.find(item => item.hours.includes(eta));

        return Promise.reject({
            error: messages.errorRunETA
                .replace('%hours', eta.toString())
                .replace('%label', label),
            html: true
        });
    }

    if (eta > 0) {
        return false;
    }

    await dailyVote(ctx, channel, date, type);
};
