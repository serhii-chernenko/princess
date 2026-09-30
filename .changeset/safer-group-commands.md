---
'princess': minor
---

- [updated] Команда /stop тепер лише ставить гру на паузу: учасниці, рахунок та історія зберігаються. Щоб продовжити, адміністратор виконує /start.
    - en: /stop now only pauses the game: players, scores and history are kept. An admin resumes it with /start.
- [updated] Поки гра на паузі, /run, /sudorun та автоматичне голосування не запускаються.
    - en: While the game is paused, /run, /sudorun and the automatic vote do not start.
- [added] Нова команда /forget для адміністраторів видаляє всю інформацію про спільноту (раніше це робила /stop).
    - en: New admin command /forget deletes all group data (this is what /stop used to do).
- [added] Перед /reset та /forget бот автоматично зберігає резервну копію на 7 днів, а команда /restore для адміністраторів повертає останню копію.
    - en: Before /reset and /forget the bot automatically keeps a backup for 7 days, and the admin command /restore brings back the latest one.
