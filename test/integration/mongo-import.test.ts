import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { prepareMongoImport } from '../../scripts/db/mongo-import';
import { countRows, createD1Harness, type D1Harness } from './d1-harness';

const playerTotal = 45;
const channelTotal = 25;
const playersPerChannel = 3;
const importTimestamp = 1_752_580_800_000;
const trickyDisplayName = 'O\'Brien "Q"; DROP TABLE players;-- \u{1F451} Хай';

const toObjectId = (kind: number, index: number) => {
    return `${kind}${index.toString(16).padStart(23, '0')}`;
};

const getPlayerIndexes = (channelIndex: number) => {
    return Array.from({ length: playersPerChannel }, (_, offset) => {
        return (channelIndex + offset) % playerTotal;
    });
};

const scoreFor = (channelIndex: number, playerIndex: number) => {
    return channelIndex * 10 + playerIndex;
};

const createFixture = () => {
    const players = Array.from({ length: playerTotal }, (_, index) => {
        return {
            _id: { $oid: toObjectId(1, index) },
            entity_id: 5000 + index,
            name: index === 0 ? trickyDisplayName : `Player ${index}`
        };
    });
    const scores: object[] = [];
    const statuses: object[] = [];
    const channels = Array.from({ length: channelTotal }, (_, channelIndex) => {
        const references = getPlayerIndexes(channelIndex).map(playerIndex => {
            const pairIndex = channelIndex * playerTotal + playerIndex;

            scores.push({
                _id: { $oid: toObjectId(3, pairIndex) },
                channel_id: { $oid: toObjectId(2, channelIndex) },
                player_id: { $oid: toObjectId(1, playerIndex) },
                score: scoreFor(channelIndex, playerIndex)
            });
            statuses.push({
                _id: { $oid: toObjectId(4, pairIndex) },
                channel_id: { $oid: toObjectId(2, channelIndex) },
                player_id: { $oid: toObjectId(1, playerIndex) },
                status: playerIndex % 2 === 0,
                auto: playerIndex % 3 === 0
            });

            return {
                player_id: { $oid: toObjectId(1, playerIndex) },
                score_id: { $oid: toObjectId(3, pairIndex) },
                status_id: { $oid: toObjectId(4, pairIndex) }
            };
        });

        return {
            _id: { $oid: toObjectId(2, channelIndex) },
            entity_id: -1000 - channelIndex,
            updated_at: { $date: '2026-07-15T12:00:00.000Z' },
            release: '4.0.1',
            players: references
        };
    });

    return { channels, players, scores, statuses };
};

const writeFixture = (directory: string) => {
    const fixture = createFixture();

    for (const [fileName, records] of [
        ['channels.json', fixture.channels],
        ['players.json', fixture.players],
        ['scores.json', fixture.scores],
        ['status.json', fixture.statuses]
    ] as const) {
        fs.writeFileSync(
            path.join(directory, fileName),
            JSON.stringify(records),
            'utf8'
        );
    }
};

const splitImportStatements = (sql: string) => {
    return sql
        .split('\n\n')
        .map(statement => {
            return statement
                .split('\n')
                .filter(line => !line.startsWith('--'))
                .join('\n')
                .trim();
        })
        .filter(statement => statement.length > 0);
};

describe('Mongo import SQL on D1', () => {
    let harness: D1Harness;
    let workDirectory: string;
    let importStatements: string[];

    const runImport = () => {
        return harness.env.DB.batch(
            importStatements.map(statement => {
                return harness.env.DB.prepare(statement);
            })
        );
    };

    before(async () => {
        harness = await createD1Harness();
        await harness.applyMigrations();
        workDirectory = fs.mkdtempSync(
            path.join(os.tmpdir(), 'princess-d1-import-')
        );
        writeFixture(workDirectory);

        const report = await prepareMongoImport({
            source: { kind: 'directory', directory: workDirectory },
            outputDirectory: path.join(workDirectory, 'output'),
            importTimestamp
        });

        importStatements = splitImportStatements(
            fs.readFileSync(report.outputSqlPath, 'utf8')
        );
    });

    after(async () => {
        await harness.dispose();
        fs.rmSync(workDirectory, { recursive: true, force: true });
    });

    beforeEach(async () => {
        await harness.clearApplicationTables();
    });

    it('splits the generated SQL into more statements than one chunk per table', () => {
        assert.ok(importStatements.length > 6);
        assert.ok(
            importStatements.every(statement => {
                return /^(PRAGMA|INSERT INTO)/.test(statement);
            })
        );
    });

    it('imports rows, memberships, scores and tricky names exactly', async () => {
        await runImport();

        assert.equal(await countRows(harness, 'players'), playerTotal);
        assert.equal(await countRows(harness, 'channels'), channelTotal);
        assert.equal(
            await countRows(harness, 'channel_members'),
            channelTotal * playersPerChannel
        );

        const tricky = await harness.env.DB.prepare(
            'SELECT display_name AS displayName, created_at AS createdAt FROM players WHERE telegram_user_id = 5000'
        ).first<{ displayName: string; createdAt: number }>();

        assert.equal(tricky?.displayName, trickyDisplayName);
        assert.equal(tricky?.createdAt, importTimestamp);

        const member = await harness.env.DB.prepare(
            `SELECT m.score, m.is_active AS isActive, m.is_auto_joined AS isAutoJoined
            FROM channel_members m
            JOIN channels c ON c.id = m.channel_id
            JOIN players p ON p.id = m.player_id
            WHERE c.telegram_chat_id = ? AND p.telegram_user_id = ?`
        )
            .bind(-1000 - 24, 5000 + 24)
            .first<{ score: number; isActive: number; isAutoJoined: number }>();

        assert.deepEqual(member, {
            score: scoreFor(24, 24),
            isActive: 1,
            isAutoJoined: 1
        });

        const memberships = await harness.env.DB.prepare(
            `SELECT count(*) AS total FROM channel_members m
            JOIN channels c ON c.id = m.channel_id
            WHERE c.telegram_chat_id = ?`
        )
            .bind(-1000 - 3)
            .first<{ total: number }>();

        assert.equal(memberships?.total, playersPerChannel);
    });

    it('fails closed on a second run without duplicating or altering data', async () => {
        await runImport();
        const scoreSumBefore = await harness.env.DB.prepare(
            'SELECT sum(score) AS total FROM channel_members'
        ).first<{ total: number }>();

        await assert.rejects(runImport(), /UNIQUE/);

        assert.equal(await countRows(harness, 'players'), playerTotal);
        assert.equal(await countRows(harness, 'channels'), channelTotal);
        assert.equal(
            await countRows(harness, 'channel_members'),
            channelTotal * playersPerChannel
        );
        assert.deepEqual(
            await harness.env.DB.prepare(
                'SELECT sum(score) AS total FROM channel_members'
            ).first(),
            scoreSumBefore
        );
    });
});
