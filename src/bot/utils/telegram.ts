import type { User } from 'telegraf/types';

import { escapeUserLabel } from './strings';

export const isForwardedReply = (
    message:
        | {
              forward_from?: unknown;
              reply_to_message?: unknown;
          }
        | undefined
) => {
    return Boolean(message?.forward_from) && Boolean(message?.reply_to_message);
};

export const isInactiveTelegramMember = (
    status: string,
    displayName: string
) => {
    return status === 'left' || status === 'kicked' || displayName === '@';
};

export const formatUserName = (
    user: Pick<User, 'username' | 'first_name' | 'last_name'>,
    value: 'nick' | 'name' = 'nick'
) => {
    const name =
        user.first_name || user.last_name
            ? `${user.first_name || ''}${
                  user.first_name && user.last_name ? ' ' : ''
              }${user.last_name || ''}`
            : `@${user.username || ''}`;
    const nick = user.username ? `@${user.username}` : name;
    const result = value === 'name' ? name : nick;

    return escapeUserLabel(result);
};

export const getTelegramDate = (unixSeconds: number | undefined) => {
    if (!unixSeconds) {
        return new Date();
    }

    return new Date(unixSeconds * 1000);
};

export const randomInt = (min: number, max: number) => {
    return (
        Math.floor(Math.random() * (Math.floor(max) - Math.ceil(min) + 1)) +
        Math.ceil(min)
    );
};
