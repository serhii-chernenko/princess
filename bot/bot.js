const {
    Telegraf,
    session,
    Scenes: { Stage }
} = require('telegraf');
const AppScenes = require('./scenes');

const bot = new Telegraf(process.env.BOT_TOKEN);
const stage = new Stage([...AppScenes]);

if (process.env.NODE_ENV === 'dev') {
    bot.use(Telegraf.log());
}

bot.use(session());
bot.use(stage.middleware());
bot.catch(error => {
    return console.error(error);
});

process.once('SIGINT', () => {
    return bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
    return bot.stop('SIGTERM');
});

module.exports = bot;
