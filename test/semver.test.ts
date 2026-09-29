import assert from 'node:assert/strict';
import test from 'node:test';

import {
    compareSemver,
    isSemverLower,
    parseSemver
} from '../src/bot/utils/semver';

test('parseSemver reads plain major.minor.patch versions only', () => {
    assert.deepEqual(parseSemver('5.10.2'), [5, 10, 2]);
    assert.deepEqual(parseSemver(' 1.0.0 '), [1, 0, 0]);
    assert.equal(parseSemver('5.0'), null);
    assert.equal(parseSemver('v5.0.0'), null);
    assert.equal(parseSemver('5.0.0-beta.1'), null);
    assert.equal(parseSemver(''), null);
});

test('compareSemver orders numerically rather than lexically', () => {
    assert.equal(compareSemver('4.0.1', '5.0.0'), -1);
    assert.equal(compareSemver('5.0.0', '4.9.9'), 1);
    assert.equal(compareSemver('5.10.0', '5.9.0'), 1);
    assert.equal(compareSemver('5.0.10', '5.0.9'), 1);
    assert.equal(compareSemver('5.0.0', '5.0.0'), 0);
});

test('unparsable versions are lower than any valid version', () => {
    assert.equal(isSemverLower('garbage', '5.0.0'), true);
    assert.equal(isSemverLower('', '0.0.1'), true);
    assert.equal(isSemverLower('5.0.0', 'garbage'), false);
    assert.equal(isSemverLower('garbage', 'garbage'), false);
});

test('isSemverLower is false for equal and newer versions', () => {
    assert.equal(isSemverLower('4.0.1', '5.0.0'), true);
    assert.equal(isSemverLower('5.0.0', '5.0.0'), false);
    assert.equal(isSemverLower('5.1.0', '5.0.0'), false);
});
