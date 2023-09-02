const bot = require('../bot');
const isForwarded = require('../helpers/forward');
const messages = require('../i18n/messages');

bot.help(async ctx => {
    try {
        if (isForwarded(ctx)) {
            return ctx;
        }

        const faq = [];

        for (let { question, answer } of messages.help) {
            if (answer.match('%repo')) {
                answer = answer.replace('%repo', process.env.GITHUB_REPO_URL);
            }

            if (answer.match(/%youtube.*/g)) {
                answer = answer
                    .replace('%youtube', process.env.YT_CHANNEL)
                    .replace('%tgChannel', process.env.TG_CHANNEL)
                    .replace('%tgGroup', process.env.TG_GROUP);
            }

            if (answer.match(/%wishlist/)) {
                answer = answer
                    .replace('%wishlistUrlTg', process.env.WISHLIST_TG_URL)
                    .replace(
                        '%wishlistUrlGH',
                        process.env.WISHLIST_GITHUB_REPO_URL
                    );
            }

            if (answer.match(/%chat.*/g)) {
                answer = answer
                    .replace('%chatGPTUrlTg', process.env.CHATGPT_TG_URL)
                    .replace(
                        '%chatGPTUrlGH',
                        process.env.CHATGPT_GITHUB_REPO_URL
                    );
            }

            if (answer.match(/%donation/)) {
                answer = answer
                    .replace('%donation', messages.DONATION)
                    .replace('%tgChannel', process.env.TG_CHANNEL);
            }

            faq.push(`<strong>${question}</strong>\n${answer}`);
        }

        return await ctx.replyWithHTML(
            messages.faq
                .replace('%faq', faq.join('\n\n'))
                .replace('%twitter', process.env.AUTHOR_TWITTER_LINK)
                .replace('%tgGroup', process.env.TG_GROUP)
                .replace('%mail', process.env.MAIL)
        );
    } catch (error) {
        console.error('help.js', error);
        await ctx.sendMessage(messages.error);
    }
});

module.exports = bot;
