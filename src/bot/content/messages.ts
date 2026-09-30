import type { WorkerBindings } from '../../worker/env';
import { getDefaultAppLocale, getTranslator, type AppLocale } from '../i18n';

export const getMessages = (locale: AppLocale = getDefaultAppLocale()) => {
    return getTranslator(locale);
};

export const LL = getMessages();
export const messages = LL;

const commandOrder = [
    'start',
    'help',
    'propose',
    'join',
    'leave',
    'run',
    'list',
    'top',
    'reset',
    'stop',
    'forget',
    'restore',
    'stats',
    'releases',
    'lang'
] as const;

const congratsOrder = [
    'line01',
    'line02',
    'line03',
    'line04',
    'line05',
    'line06',
    'line07',
    'line08',
    'line09',
    'line10',
    'line11',
    'line12',
    'line13',
    'line14',
    'line15',
    'line16',
    'line17',
    'line18',
    'line19'
] as const;

export const releaseGroupOrder = [
    'added',
    'updated',
    'fixed',
    'removed',
    'notes'
] as const;

export type ReleaseGroup = (typeof releaseGroupOrder)[number];

const getHourLabelKey = (hours: number) => {
    if (hours === 1 || hours === 21) {
        return 'one';
    }

    if ([2, 3, 4, 22, 23, 24].includes(hours)) {
        return 'few';
    }

    return 'many';
};

export const getHourLabel = (
    hours: number,
    locale: AppLocale = getDefaultAppLocale()
) => {
    const LL = getMessages(locale);

    return LL.hours[getHourLabelKey(hours)]();
};

export const getCommandList = (locale: AppLocale = getDefaultAppLocale()) => {
    const LL = getMessages(locale);

    return commandOrder.map(command => LL.commands[command]());
};

export const getCongratsMessages = (
    nick: string,
    locale: AppLocale = getDefaultAppLocale()
) => {
    const LL = getMessages(locale);

    return congratsOrder.map(line => {
        return LL.congrats[line]({
            nick
        });
    });
};

export const getHelpEntries = (
    env: WorkerBindings,
    locale: AppLocale = getDefaultAppLocale()
) => {
    const LL = getMessages(locale);

    return [
        {
            question: LL.help.items.howToStart.question(),
            answer: LL.help.items.howToStart.answer()
        },
        {
            question: LL.help.items.rename.question(),
            answer: LL.help.items.rename.answer()
        },
        {
            question: LL.help.items.projects.question(),
            answer: LL.help.items.projects.answer({
                youtube: env.YT_CHANNEL || '',
                tgChannel: env.TG_CHANNEL || '',
                tgGroup: env.TG_GROUP || '',
                wishlistUrlTg: env.WISHLIST_TG_URL || '',
                chatGPTUrlGH: env.CHATGPT_GITHUB_REPO_URL || ''
            })
        },
        {
            question: LL.help.items.restore.question(),
            answer: LL.help.items.restore.answer()
        }
    ];
};

export const getReleaseLabels = (
    locale: AppLocale = getDefaultAppLocale()
): Record<ReleaseGroup, string> => {
    const LL = getMessages(locale);

    return {
        added: LL.releases.labels.added(),
        updated: LL.releases.labels.updated(),
        fixed: LL.releases.labels.fixed(),
        removed: LL.releases.labels.removed(),
        notes: LL.releases.labels.notes()
    };
};

export const getAvailableLanguagesMessage = (
    locale: AppLocale = getDefaultAppLocale()
) => {
    const LL = getMessages(locale);

    return LL.lang.available();
};
