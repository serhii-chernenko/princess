export const allowedReleaseGroups = new Set([
    'added',
    'updated',
    'fixed',
    'removed',
    'notes'
]);

const bulletPattern = /^- \[(added|updated|fixed|removed|notes)\] .+$/;
const nestedEnglishPattern = /^\s+- en: (.*)$/;
const topLevelEnglishPattern = /^- en:/;
const malformedEnglishPattern = /^\s+- en:/i;

export const validateChangesetBody = (fileName: string, body: string) => {
    if (!body.trim()) {
        throw new Error(`${fileName} must include at least one tagged bullet`);
    }

    let hasOpenBullet = false;
    let hasEnglishText = false;

    for (const line of body.split('\n')) {
        if (!line.trim()) {
            continue;
        }

        const bulletMatch = line.match(bulletPattern);

        if (bulletMatch) {
            const group = bulletMatch[1];

            if (!group || !allowedReleaseGroups.has(group)) {
                throw new Error(
                    `${fileName} uses unsupported release group ${group}`
                );
            }

            hasOpenBullet = true;
            hasEnglishText = false;
            continue;
        }

        if (topLevelEnglishPattern.test(line)) {
            throw new Error(
                `${fileName} has an English line that is not nested under a tagged bullet. Indent it as '  - en: ...'.`
            );
        }

        if (malformedEnglishPattern.test(line)) {
            const englishMatch = line.match(nestedEnglishPattern);

            if (!englishMatch?.[1]?.trim()) {
                throw new Error(
                    `${fileName} has an English line without text. Use '  - en: English text'.`
                );
            }

            if (!hasOpenBullet) {
                throw new Error(
                    `${fileName} has an English line before any tagged bullet.`
                );
            }

            if (hasEnglishText) {
                throw new Error(
                    `${fileName} has more than one English line for a single bullet.`
                );
            }

            hasEnglishText = true;
            continue;
        }

        if (hasOpenBullet) {
            continue;
        }

        throw new Error(
            `${fileName} has an invalid line. Use '- [added|updated|fixed|removed|notes] ...' bullets.`
        );
    }
};
