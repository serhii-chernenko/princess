import { i18nObject } from '../i18n/i18n-util';
import { loadLocale } from '../i18n/i18n-util.sync';
import type { Locales, TranslationFunctions } from '../i18n/i18n-types';

export type AppLocale = 'en' | 'ua';

const defaultAppLocale: AppLocale = 'ua';
const appLocaleMap: Record<AppLocale, Locales> = {
    en: 'en',
    ua: 'uk'
};
const translatorCache: Partial<Record<Locales, TranslationFunctions>> = {};

export const getDefaultAppLocale = (): AppLocale => {
    return defaultAppLocale;
};

export const getAvailableLanguageCodes = (): AppLocale[] => {
    return ['en', 'ua'];
};

export const normalizeAppLocale = (
    value: string | undefined | null
): AppLocale | null => {
    if (!value) {
        return null;
    }

    const normalized = value.trim().toLowerCase();

    if (normalized === 'uk') {
        return 'ua';
    }

    if (normalized === 'en' || normalized === 'ua') {
        return normalized;
    }

    return null;
};

export const mapAppLocaleToI18nLocale = (
    locale: AppLocale = defaultAppLocale
) => {
    return appLocaleMap[locale];
};

export const getTranslator = (locale: AppLocale = defaultAppLocale) => {
    const i18nLocale = mapAppLocaleToI18nLocale(locale);
    const cachedTranslator = translatorCache[i18nLocale];

    if (cachedTranslator) {
        return cachedTranslator;
    }

    loadLocale(i18nLocale);
    const translator = i18nObject(i18nLocale);

    translatorCache[i18nLocale] = translator;

    return translator;
};
