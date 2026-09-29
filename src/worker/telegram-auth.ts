export const TELEGRAM_SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

export interface SecretComparisonCrypto {
    digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
    timingSafeEqual(left: ArrayBuffer, right: ArrayBuffer): boolean;
}

export type SecretMatcher = (
    provided: string,
    expected: string
) => Promise<boolean>;

export const compareSecrets = async (
    provided: string,
    expected: string,
    subtle: SecretComparisonCrypto = crypto.subtle
) => {
    const encoder = new TextEncoder();
    const [providedHash, expectedHash] = await Promise.all([
        subtle.digest('SHA-256', encoder.encode(provided)),
        subtle.digest('SHA-256', encoder.encode(expected))
    ]);

    return subtle.timingSafeEqual(providedHash, expectedHash);
};
