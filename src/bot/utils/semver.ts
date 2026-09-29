const semverPattern = /^(\d+)\.(\d+)\.(\d+)$/;

export type ParsedSemver = readonly [number, number, number];

export const parseSemver = (value: string): ParsedSemver | null => {
    const match = semverPattern.exec(value.trim());

    if (!match) {
        return null;
    }

    return [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const compareSemver = (left: string, right: string) => {
    const parsedLeft = parseSemver(left);
    const parsedRight = parseSemver(right);

    if (!parsedLeft && !parsedRight) {
        return 0;
    }

    if (!parsedLeft) {
        return -1;
    }

    if (!parsedRight) {
        return 1;
    }

    for (const index of [0, 1, 2] as const) {
        const difference = parsedLeft[index] - parsedRight[index];

        if (difference !== 0) {
            return Math.sign(difference);
        }
    }

    return 0;
};

export const isSemverLower = (candidate: string, reference: string) => {
    return compareSemver(candidate, reference) < 0;
};
