const { join } = require('path');

require('dotenv').config({
    path: join(__dirname, '..', 'env', `.env.${process.env.NODE_ENV}`)
});

const mongoose = require('mongoose');

mongoose.set('strictQuery', false);

module.exports = async () => {
    try {
        await new mongoose.connect(process.env.MONGODB_URI);

        console.log(
            JSON.stringify({
                event: 'legacy_mongo_connection_succeeded'
            })
        );
    } catch (error) {
        console.error(
            JSON.stringify({
                event: 'legacy_mongo_connection_failed',
                errorType: error instanceof Error ? error.name : typeof error
            })
        );
        throw error;
    }
};
