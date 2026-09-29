const restrictSymbols = [
    {
        symbol: '<3',
        replace: '❤️'
    }
] as const;

export const escapeUserLabel = (value: string) => {
    let result = value;

    for (const { symbol, replace } of restrictSymbols) {
        result = result.replace(symbol, replace);
    }

    return result;
};

export const escapeHtml = (value: string) => {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
};

export const replaceTemplate = (
    value: string,
    replacements: Record<string, string>
) => {
    let result = value;

    for (const [token, replacement] of Object.entries(replacements)) {
        result = result.replaceAll(token, replacement);
    }

    return result;
};
