import assert from 'node:assert/strict';
import test from 'node:test';

import { validateChangesetBody } from '../scripts/releases/changeset-validator';
import { parseChangelog } from '../scripts/releases/changelog-parser';

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
