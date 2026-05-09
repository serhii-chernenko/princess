const { Schema, model } = require('mongoose');
const Score = require('./score');
const Status = require('./status');
const Player = require('./player');
const getVersion = require('../helpers/version');

const ChannelSchema = new Schema({
    entity_id: {
        type: Number,
        required: true,
        unique: true
    },
    updated_at: {
        type: Date,
        default: null
    },
    release: {
        type: String,
        required: true,
        default: getVersion()
    },
    players: [
        {
            player_id: {
                type: Schema.Types.ObjectId,
                ref: 'Player'
            },
            score_id: {
                type: Schema.Types.ObjectId,
                ref: 'Score'
            },
            status_id: {
                type: Schema.Types.ObjectId,
                ref: 'Status'
            }
        }
    ]
});

ChannelSchema.methods.addPlayer = async function (player, score, status) {
    const players = [...this.players];
    const existingPlayer = players.find(channelPlayer => {
        return channelPlayer.player_id.toString() === player._id.toString();
    });

    if (existingPlayer) {
        return this;
    }

    players.push({
        player_id: player._id,
        score_id: score._id,
        status_id: status._id
    });

    this.players = players;

    await this.save();
};

ChannelSchema.methods.removePlayers = async function () {
    for await (const { player_id, status_id, score_id } of this.players) {
        await Status.findByIdAndRemove(status_id);
        await Score.findByIdAndRemove(score_id);

        const filter = { player_id };
        const otherStatuses = await Status.find(filter).count();
        const otherScores = await Score.find(filter).count();

        if (!otherStatuses && !otherScores) {
            await Player.findByIdAndDelete(player_id);
        }
    }

    this.players = [];
    this.updated_at = null;

    await this.save();
};

module.exports = model('Channel', ChannelSchema);
