const { Schema, model } = require('mongoose');

module.exports = model(
    'Status',
    new Schema({
        channel_id: {
            type: Schema.Types.ObjectId,
            ref: 'Channel'
        },
        player_id: {
            type: Schema.Types.ObjectId,
            ref: 'Player'
        },
        status: {
            type: Boolean,
            default: true,
            required: true
        },
        auto: {
            type: Boolean,
            default: true,
            required: true
        }
    })
);
