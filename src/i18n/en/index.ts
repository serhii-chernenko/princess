import type { BaseTranslation } from '../i18n-types';

const en: BaseTranslation = {
    donationGeneral: '',
    donationLocal: '',
    proposalEnter: 'Send your version!',
    proposalWrong: `You can't suggest a command. Try again 🤷‍♀`,
    proposalLeave: 'Your suggestion will be reviewed!',
    from: 'Author: {value:string}',
    error: `Well, that went sideways...\nTry again 🤷‍♀️`,
    errorRunEta: `You can run the princess detector only once a day.\nWait <strong>{hours:number}</strong> more {label:string}! 🙅‍♀️`,
    hours: {
        one: 'hour',
        few: 'hours',
        many: 'hours'
    },
    successJoin: `You're officially in the princess race now, {name:string}! 🙋‍♀️`,
    alreadyJoin: `You're already in, {name:string}! 🙅‍♀️`,
    successBack: `Glad you're back, {name:string}! 🙋‍♀️`,
    successLeave: `You won't be today's princess anymore, {name:string}! 🙍‍♀️`,
    alreadyLeave: `You already opted out of the game, {name:string}! 🙅‍♀️`,
    successReset: `Princess achievements wiped clean! 💇‍♀️\nChanged your mind? An admin can bring them back with /restore@{username:string} within 7 days.`,
    successStop: `The game is paused ⏸️ Players and scores are kept.\nTo resume, an admin runs /start.`,
    alreadyStop: `The game is already paused ⏸️\nTo resume, an admin runs /start.`,
    gameStopped: `The game is paused ⏸️ The princess detector is resting.\nTo resume, an admin runs /start.`,
    successResume: `The game is back on! ▶️ The princess detector is working again.`,
    successForget: `All data about this group has been deleted! 💇‍♀️\nIf this was an accident, an admin can bring it back with /restore@{username:string} within 7 days.`,
    successRestore: `Group data restored! 👸 Players and scores are back.`,
    restoreNotFound: `There is nothing to restore. Backups are kept for 7 days. 🤷‍♀️`,
    snapshotTooLarge: `This group is too large to back up, so the command was cancelled. Please contact the bot author. 🙅‍♀️`,
    groupCommandNeedsBotName: `In groups this command only works with the bot's name, so several bots don't run it by accident 🙅‍♀️\nWrite /{command:string}@{username:string}`,
    groupCommandsNote: `In groups, write /reset, /stop, /forget and /restore with the bot's name, for example /stop@{username:string}`,
    playersWithScoresNotFound: `The princess detector couldn't find any players with a score! 🤷‍♀️️`,
    playersNotFound: `Nobody in this group wants to be a princess yet! 🤷‍♀️`,
    playersNotEnough: `This group doesn't have enough princess volunteers yet. You need at least 2! 🤷‍♀️`,
    accessDenied: `Sorry babe, you don't have access, {name:string}! 🙅‍♀️`,
    sudoRun: `Feeling like a programmer today, {name:string}? lol 🙅‍♀`,
    hasNotData: `The princess detector has no data for this chat yet! 🤷‍♀️`,
    greetings: `Your Highness, <strong>{name:string}</strong>! 🙋‍♀️`,
    greetingsError: 'Please add the bot to a group and run:\n/start',
    winner: `Princess of the day:\n\n👸 <strong>{name:string}</strong>\n\n`,
    top: `TOP-10 princesses of this group 👸`,
    players: `Player list 👸`,
    stats: `<strong>Bot usage stats:</strong>\n\nGroups: <strong>{groups:number}</strong>\nPlayers: <strong>{players:number}</strong>\n\n<strong>Bot author:</strong>\n- {youtube:string}\n- Email: {mail:string}`,
    commandsLabel: 'Bot commands',
    commands: {
        start: '/start - Initialize the bot in the group, resume a paused game and show commands',
        help: '/help - Questions and answers',
        propose: '/propose - Suggest your own princess greeting',
        join: '/join - Join the game',
        leave: '/leave - Leave the game',
        run: '/run - Start the first vote',
        list: '/list - Show all players',
        top: '/top - Show TOP-10 players',
        reset: '/reset - Reset player scores (can be undone with /restore)',
        stop: '/stop - Pause the game (data is kept)',
        forget: '/forget - Delete all group data (can be undone with /restore within 7 days)',
        restore:
            '/restore - Bring back data after /reset or /forget (within 7 days)',
        stats: '/stats - Show bot usage stats',
        releases: '/releases - Show all bot versions and changes',
        lang: '/lang - Show or change the group language'
    },
    lang: {
        available: 'Available languages: en, ua\nДоступні мови: en, ua',
        updated: 'Group language changed to {language:string}.',
        invalid:
            'Unknown language code: {language:string}.\n\nAvailable languages: {languages:string}\nДоступні мови: {languages:string}'
    },
    congrats: {
        line01: `{nick:string}, today you're the prettiest flower on the whole planet!`,
        line02: `{nick:string}, today you absolutely belong on the cover of Cosmopolitan because they're clearly missing their star model!`,
        line03: `Today you're one irresistible little cupcake, {nick:string}!`,
        line04: `It's your turn to sleep on the pea tonight, {nick:string}, my princess!`,
        line05: `It's such a treat to see a princess in real life, not just in fairy tales, {nick:string}!`,
        line06: `{nick:string}, your beauty deserves a golden crown!`,
        line07: `A girl like you comes once in a lifetime, {nick:string}!`,
        line08: `{nick:string}, not everyone is worthy of your magic!`,
        line09: `{nick:string}, today you're pretty as an Easter egg!`,
        line10: `My dear {nick:string}, the crown is yours today`,
        line11: `That wasn't a new star lighting up the sky. That was {nick:string} blooming down here!`,
        line12: `I fell for you, {nick:string}, completely and hopelessly!`,
        line13: `You're not like the others, {nick:string}, you're a girl from another universe!`,
        line14: `{nick:string}, you're exactly the wild queen songs are written about!`,
        line15: `{nick:string}, today you're a fierce little tigress!`,
        line16: `{nick:string}, shine bright like a diamond!`,
        line17: `{nick:string}, you're sweet trouble in the best way!`,
        line18: `{nick:string}, with you around even winter starts feeling like spring!`,
        line19: `{nick:string}, without you a warm summer night feels cold as winter!`
    },
    faq: '<strong>Questions and answers:</strong>\n\n{faq:string}\n\n<strong>If you have any questions, feel free to contact the bot author:</strong>\n- Email: {mail:string}',
    help: {
        items: {
            howToStart: {
                question: 'How do I start the game?',
                answer: '- Add the bot to the group.\n- Run /start.\n- Everyone who wants to play should run /join.\n- Once everyone has joined, run /run.\n- After that, the bot will automatically trigger a vote every 24 hours.'
            },
            rename: {
                question: `What happens if I change my nickname or name?`,
                answer: `Each player is tracked by a unique Telegram user ID.\nDuring every vote, and when lists are built with:\n/list and /top\nthe bot refreshes that player's current data in the database.\nSo no worries :)`
            },
            projects: {
                question: `Does the author have other projects?`,
                answer: `Yep, absolutely. Thanks for being curious :)\n\n<i>YouTube channel</i>:\n- {youtube:string}\n- {tgChannel:string}\n- {tgGroup:string}\n\n<i>Wishlist</i>:\n- {wishlistUrlTg:string}\n\n<i>ChatGPT Telegram bot</i>:\n- {chatGPTUrlGH:string}`
            },
            restore: {
                question: 'What if the group data was deleted by accident?',
                answer: '- /stop only pauses the game: players and scores stay, and /start resumes it.\n- Before /reset and /forget the bot automatically keeps a backup for 7 days.\n- An admin can run /restore to bring back the latest backup.\n- In groups write /stop, /reset, /forget and /restore with the @username of the bot, for example /stop@bot_username. In groups with several bots Telegram usually adds it automatically when you pick the command from the menu.'
            }
        }
    },
    releases: {
        labels: {
            added: 'Added',
            updated: 'Changed',
            fixed: 'Fixed',
            removed: 'Removed',
            notes: 'Notes'
        },
        announcement: {
            title: 'The bot has been updated to version {version:string} 🎉',
            footer: 'All changes and previous versions: /releases'
        }
    }
};

export default en;
