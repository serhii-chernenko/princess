import assert from 'node:assert/strict';
import test from 'node:test';

import { validateChangesetBody } from '../scripts/releases/changeset-validator';
import { parseChangelog } from '../scripts/releases/changelog-parser';
import {
    findRelease,
    getReleaseTitle,
    parseGithubReleaseArguments,
    publishGithubReleases,
    renderGithubReleaseNotes,
    type GithubCli
} from '../scripts/releases/github-release';

const validate = (body: string) => {
    return () => validateChangesetBody('sample.md', body);
};

test('changeset validator accepts Ukrainian-only bullets', () => {
    assert.doesNotThrow(
        validate('- [added] Нова команда\n- [fixed] Виправлення')
    );
});

test('changeset validator accepts a nested English line', () => {
    assert.doesNotThrow(
        validate('- [added] Нова команда\n  - en: New command\n- [fixed] Фікс')
    );
});

test('changeset validator still accepts multi-line legacy continuations', () => {
    assert.doesNotThrow(
        validate(
            '- [notes] Перший рядок\n\n  Другий рядок\n  https://example.com'
        )
    );
});

test('changeset validator rejects empty bodies and untagged bullets', () => {
    assert.throws(validate('  \n'), /at least one tagged bullet/);
    assert.throws(validate('- Без тегу'), /invalid line/);
    assert.throws(validate('- [bogus] text'), /invalid line/);
});

test('changeset validator rejects malformed English lines', () => {
    assert.throws(validate('- [added] Текст\n  - en:'), /without text/);
    assert.throws(validate('- [added] Текст\n  - en:   '), /without text/);
    assert.throws(validate('  - en: Orphan'), /before any tagged bullet/);
    assert.throws(validate('- [added] Текст\n- en: Top level'), /not nested/);
    assert.throws(
        validate('- [added] Текст\n  - en: One\n  - en: Two'),
        /more than one English line/
    );
});

test('changeset validator requires Ukrainian text on the bullet itself', () => {
    assert.throws(
        validate('- [added]\n  - en: Only English'),
        /invalid line|only|before/i
    );
});

const changelog = `# princess

## 5.0.0 - 29.09.2026

### Major Changes

- [updated] Українською
  - en: In English
- [updated] Лише українською
- [notes] Багаторядкова
  примітка
  - en: Multi-line
    note

## 4.0.1 - 17.08.2024

### Patch Changes

- [notes] Сьогодні в мене день народження

    Привітати мене можна

    Дякую!
`;

test('changelog parser reads bilingual items', () => {
    const [release] = parseChangelog(changelog);

    assert.equal(release?.version, '5.0.0');
    assert.equal(release?.date, '29.09.2026');
    assert.deepEqual(release?.groups.updated, [
        { uk: 'Українською', en: 'In English' },
        { uk: 'Лише українською' }
    ]);
    assert.deepEqual(release?.groups.notes, [
        { uk: 'Багаторядкова\nпримітка', en: 'Multi-line\nnote' }
    ]);
});

test('changelog parser keeps legacy Ukrainian-only history without an English key', () => {
    const legacy = parseChangelog(changelog)[1];

    assert.equal(legacy?.version, '4.0.1');
    assert.equal(legacy?.groups.notes?.length, 1);
    assert.equal('en' in (legacy?.groups.notes?.[0] ?? {}), false);
    assert.match(legacy?.groups.notes?.[0]?.uk ?? '', /^Сьогодні в мене/);
    assert.match(legacy?.groups.notes?.[0]?.uk ?? '', /Дякую!$/);
});

test('changelog parser understands the raw changesets bullet shape', () => {
    const raw = `## 6.0.0 - 01.01.2027

### Major Changes

-   abc1234: - [added] Перше
    -   en: First
    -   [fixed] Друге
        -   en: Second
`;
    const [release] = parseChangelog(raw);

    assert.deepEqual(release?.groups.added, [{ uk: 'Перше', en: 'First' }]);
    assert.deepEqual(release?.groups.fixed, [{ uk: 'Друге', en: 'Second' }]);
});

test('changelog parser orders groups and requires release dates', () => {
    const [release] = parseChangelog(
        '## 1.0.0 - 01.01.2020\n\n- [notes] n\n- [added] a\n'
    );

    assert.deepEqual(Object.keys(release?.groups ?? {}), ['added', 'notes']);
    assert.throws(() => parseChangelog('## 1.0.0\n'), /Missing release date/);
});

const githubReleases = parseChangelog(`# princess

## 5.1.0 - 30.09.2026

### Minor Changes

- [added] Нове
    - en: New

## 5.0.0 - 29.09.2026

### Major Changes

- [notes] Примітка
    - en: A note
- [added] Одне
    - en: One
- [added] Два
  друга лінія
    - en: Two
      second line
- [fixed] Лише українською

## 4.0.1 - 17.08.2024

### Patch Changes

- [notes] Староапізня примітка
`);

test('github release notes prefer English, follow group order and indent continuations', () => {
    const release = findRelease(githubReleases, '5.0.0');

    assert.equal(
        renderGithubReleaseNotes(release),
        [
            '### Added',
            '',
            '- One',
            '- Two',
            '  second line',
            '',
            '### Fixed',
            '',
            '- Лише українською',
            '',
            '### Notes',
            '',
            '- A note',
            ''
        ].join('\n')
    );
});

test('github release notes fall back to Ukrainian for legacy releases', () => {
    const release = findRelease(githubReleases, '4.0.1');

    assert.equal(
        renderGithubReleaseNotes(release),
        '### Notes\n\n- Староапізня примітка\n'
    );
});

test('github release lookup, title and arguments are strict', () => {
    assert.throws(() => findRelease(githubReleases, '9.9.9'), /not in/);
    assert.equal(
        getReleaseTitle(findRelease(githubReleases, '5.0.0')),
        '5.0.0 - 2026-09-29'
    );
    assert.deepEqual(
        parseGithubReleaseArguments([
            '--version',
            '5.0.0',
            '--target',
            'abc',
            '--print'
        ]),
        { version: '5.0.0', target: 'abc', print: true }
    );
    assert.deepEqual(parseGithubReleaseArguments([]), {
        version: null,
        target: null,
        print: false
    });
    assert.throws(() => parseGithubReleaseArguments(['--version']), /value/);
    assert.throws(() => parseGithubReleaseArguments(['--bogus']), /Unknown/);
});

const createFakeGithub = (existing: string[] = []) => {
    const present = new Set(existing);
    const created: { tag: string; target: string; isLatest: boolean }[] = [];
    const cli: GithubCli = {
        releaseExists: tag => {
            return present.has(tag);
        },
        createRelease: ({ tag, target, isLatest }) => {
            created.push({ tag, target, isLatest });
            present.add(tag);
        }
    };

    return { cli, created };
};

const PUBLISHING_COMMIT = 'sha-head';

const createDependencies = (cli: GithubCli) => {
    return { cli, target: PUBLISHING_COMMIT, log: () => {} };
};

test('github release publishing creates missing releases from 5.0.0 oldest first and is idempotent', () => {
    const { cli, created } = createFakeGithub();
    const dependencies = createDependencies(cli);
    const options = { version: null, target: null, print: false };

    assert.deepEqual(
        publishGithubReleases(githubReleases, options, dependencies),
        ['5.0.0', '5.1.0']
    );
    assert.deepEqual(created, [
        { tag: '5.0.0', target: PUBLISHING_COMMIT, isLatest: false },
        { tag: '5.1.0', target: PUBLISHING_COMMIT, isLatest: true }
    ]);
    assert.deepEqual(
        publishGithubReleases(githubReleases, options, dependencies),
        []
    );
    assert.equal(created.length, 2);
});

test('github release publishing skips releases that already exist', () => {
    const { cli, created } = createFakeGithub(['5.0.0']);
    const logged: string[] = [];
    const dependencies = {
        cli,
        target: PUBLISHING_COMMIT,
        log: (message: string) => {
            logged.push(message);
        }
    };

    assert.deepEqual(
        publishGithubReleases(
            githubReleases,
            { version: null, target: null, print: false },
            dependencies
        ),
        ['5.1.0']
    );
    assert.deepEqual(created, [
        { tag: '5.1.0', target: PUBLISHING_COMMIT, isLatest: true }
    ]);
    assert.deepEqual(logged, [
        'GitHub release 5.0.0 already exists; skipping.',
        'Created GitHub release 5.1.0.'
    ]);
});

test('github release publishing honors an explicit older version and target', () => {
    const { cli, created } = createFakeGithub();

    assert.deepEqual(
        publishGithubReleases(
            githubReleases,
            { version: '4.0.1', target: 'abc', print: false },
            createDependencies(cli)
        ),
        ['4.0.1']
    );
    assert.deepEqual(created, [
        { tag: '4.0.1', target: 'abc', isLatest: false }
    ]);
});
