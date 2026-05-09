const { join } = require('path');

const envFileName =
    process.env.NODE_ENV === 'production'
        ? '.dev.vars.production'
        : '.dev.vars';

require('dotenv').config({
    path: join(__dirname, '..', envFileName)
});

const mongoose = require('mongoose');

mongoose.set('strictQuery', false);

module.exports = async () => {
    try {
        await new mongoose.connect(process.env.MONGODB_URI);

        console.log('DB successfully connected!');
        Promise.resolve();
    } catch (error) {
        console.log('DB connection error!');
        Promise.reject(error);
    }
};
