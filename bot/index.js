require('./connect-db')()
    .then(async () => {
        const bot = require('./bot');
        const Channel = require('./models/channel');
        const cleanDB = require('./helpers/clean-db');
        const releasesToPost = require('./helpers/releases');
        const getVersions = require('./helpers/versions');
        const getVersion = require('./helpers/version');
        const searchCriteria = require('./helpers/search-criteria');

        require('./commands');
        require('./listeners');

        try {
            bot.launch(); // don't add await before. launch() returns promise always in pending

            console.log('Bot successfully launched!');

            await cleanDB();
        } catch (error) {
            await Promise.reject(error);
        }

        let channels;

        try {
            channels = await Channel.find(searchCriteria());
        } catch (error) {
            await Promise.reject(error);
        }

        if (!channels.length) {
            return this;
        }

        for await (const channel of channels) {
            const releaseIndex = getVersions().findIndex(
                release => release.version === channel.release
            );

            try {
                await bot.telegram.sendMessage(
                    channel.entity_id,
                    releasesToPost(releaseIndex),
                    {
                        parse_mode: 'HTML'
                    }
                );
            } catch (error) {
                if (error.response.error_code === 403) {
                    await channel.removePlayers();
                    await Channel.findOneAndRemove({
                        entity_id: error.on.payload.chat_id
                    });
                }
            }
        }

        try {
            await Channel.updateMany(searchCriteria(), {
                release: getVersion()
            });
        } catch (error) {
            await Promise.reject(error);
        }
    })
    .catch(error => console.log(error));
