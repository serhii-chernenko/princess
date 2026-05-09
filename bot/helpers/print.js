const addActivePlayers = require('./add-players');
const sortByScoreAndLimit = require('./sort');
const messages = require('../i18n/messages');

module.exports = async (ctx, channel, list = 'top') => {
    const activePlayers = await addActivePlayers(ctx, channel, list);

    if (!activePlayers.length) {
        return Promise.reject({
            error: messages.playersWithScoresNotFound
        });
    }

    if (list === 'top') {
        const sortedPlayersByScore = await sortByScoreAndLimit(activePlayers);
        const sortedArray = sortedPlayersByScore.map(
            ({ player: { name }, score: { score } }, index) => {
                if (index === 0) {
                    return `${
                        index + 1
                    }. <strong>${name}</strong>: ${score} 👸`;
                }

                return `${index + 1}. ${name}: ${score}`;
            }
        );

        return await ctx.replyWithHTML(
            `<strong>${messages.top} (${sortedArray.length}):</strong>\n\n` +
                sortedArray.join('\n')
        );
    } else if (list === 'all') {
        return ctx.replyWithHTML(
            `<strong>${messages.players} (${activePlayers.length}):</strong>\n\n` +
                activePlayers
                    .sort((a, b) => (a.score.score < b.score.score ? 1 : -1))
                    .map(({ player: { name }, score: { score } }, index) => {
                        return `${index + 1}. ${name}: ${score}`;
                    })
                    .join('\n')
        );
    }
};
