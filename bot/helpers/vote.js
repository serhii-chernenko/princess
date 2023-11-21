const Score = require('../models/score');
const addActivePlayers = require('./add-players');
const returnUserName = require('./username');
const printPlayers = require('./print');
const returnRandomInt = require('./random-int');
const messages = require('../i18n/messages');

const resetChannel = async (
    ctx,
    channel,
    type,
    error = messages.playersNotFound
) => {
    if (type === 'auto') {
        return ctx;
    }

    await channel.updateOne({
        updated_at: null
    });

    return Promise.reject({
        error
    });
};

const dailyVote = async (ctx, channel, date, type) => {
    if (!channel.players.length) {
        return await resetChannel(ctx, channel);
    }

    const activePlayers = await addActivePlayers(ctx, channel, 'all');

    if (!activePlayers.length) {
        return await resetChannel(ctx, channel, type);
    } else if (activePlayers.length < 2) {
        return await resetChannel(
            ctx,
            channel,
            type,
            messages.playersNotEnough
        );
    }

    const { member, score } =
        activePlayers[returnRandomInt(0, activePlayers.length - 1)];

    const updatedScore = await Score.findById(score._id);

    await updatedScore.updateOne({
        score: updatedScore.score + 1
    });
    await channel.updateOne({
        updated_at: date
    });

    let resultMessage =
        messages.winner.replace('%name', returnUserName(member.user, 'name')) +
        `<em>${messages.congrats[
            returnRandomInt(0, messages.congrats.length - 1)
        ].replace(
            '%nick',
            `<strong>${returnUserName(member.user)}</strong>`
        )} ❤️</em>`;

    if (messages.DONATION_LOCAL) {
        resultMessage += `\n\n${messages.DONATION_LOCAL}\n\n`.replace(
            '%tgChannel',
            process.env.TG_CHANNEL
        );
    }

    await ctx.replyWithHTML(resultMessage);
    await printPlayers(ctx, channel);
};

module.exports = dailyVote;
