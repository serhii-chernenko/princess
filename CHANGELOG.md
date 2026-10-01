# princess

## 5.1.0 - 01.10.2026

### Minor Changes

- [updated] Команда /stop більше нічого не видаляє: вона лише ставить гру на паузу, а учасниці, рахунок та історія зберігаються. Поки гра на паузі, /run, /sudorun та автоматичне голосування не працюють. Щоб продовжити, адміністратор виконує /start.
    - en: /stop no longer deletes anything: it only pauses the game, and players, scores and history are kept. While the game is paused, /run, /sudorun and the automatic vote do not work. To continue, an admin runs /start.
- [added] Нова команда /forget для адміністраторів повністю видаляє дані спільноти: раніше це робила /stop. На відміну від /reset, який лише обнуляє рахунок і залишає учасниць, /forget видаляє й учасниць.
    - en: New admin command /forget deletes all community data, which is what /stop used to do. Unlike /reset, which only zeroes the scores and keeps the players, /forget removes the players too.
- [added] Резервні копії: перед /reset та /forget бот автоматично зберігає копію даних спільноти на 7 днів. Адміністратор може повернути її командою /restore, навіть якщо спільноту вже видалено.
    - en: Backups: before /reset and /forget the bot automatically keeps a copy of the community data for 7 days. An admin can bring it back with /restore, even after the community was deleted.
- [notes] У групах команди /stop, /reset, /forget та /restore працюють лише з іменем бота, наприклад /stop@bot_username. Так звичайна /stop, призначена іншому боту, не спрацює ще й у цьому. Без імені бот підкаже правильний запис.
    - en: In groups, /stop, /reset, /forget and /restore only work with the bot name, for example /stop@bot_username. This way a plain /stop meant for another bot is not also acted on by this bot. Without the name the bot replies with the correct form.

## 5.0.0 - 29.09.2026

### Major Changes

- [updated] Бот переїхав на нову хмарну інфраструктуру та нову базу даних. Усі спільноти, учасниці та їхні очки збережені.
    - en: The bot has moved to a new cloud infrastructure and a new database. All communities, players and their points are preserved.
- [updated] Бот працює швидше та стабільніше.
    - en: The bot is now faster and more reliable.
- [added] Команда /lang: адміністратори спільноти можуть обрати мову бота (українська або англійська). Admins can switch the bot to English with /lang en.
    - en: New /lang command: community admins can choose the bot language (Ukrainian or English).
- [notes] Щоб у розіграші брали участь усі учасниці гри, а не лише ті, хто нещодавно писав у чат, зробіть бота адміністратором спільноти. Жодних додаткових прав не потрібно.
    - en: To make sure every player takes part in the draw, not only those who wrote in the chat recently, make the bot an administrator of the community. No extra permissions are needed.
- [updated] Повідомлення про нові версії бота тепер надходять надійніше. Усі зміни завжди можна переглянути командою /releases.
    - en: New version announcements are now delivered more reliably. All changes are always available via /releases.

## 4.0.1 - 17.08.2024

### Patch Changes

- [notes] Сьогодні в мене день народження 🥳

    Привітати мене можна у відгуках бота або донатом на банку:
    https://send.monobank.ua/jar/4ZGhPQqyMh

    Або PayPal:
    contact@chernenko.digital

    Дякую за увагу!😅

## 4.0.0 - 11.02.2023

### Major Changes

- [fixed] Виправлена проблема одночасного запуску декількох голосувань. Дякую Maksym Novik за допомогу!

## 3.0.0 - 22.05.2022

### Major Changes

- [added] Нові привітання для принцесок.
- [added] Команда /propose, щоб ви могли запропонувати свій варіант привітання для принцески.
- [added] Видалення гравців, які не мають активного статусу в жодній із спільнот.
- [added] Команда /stop, яка зупиняє гру та видаляє всю інформацію про спільноту.
- [added] Після оновлення версії боту, буде здійснюватися розсилка з інформацією про зміни.
- [added] Команда /releases показує всі версії боту та зміни в них.
- [updated] Команда /stats тепер показує тільки активні спільноти (в яких запуск був уже здійснений та не пізніше місяця по тому) та гравців (які мають активний статус хоча б в одній зі спільнот).

## 2.0.0 - 12.12.2020

### Major Changes

- [added] Нові привітання для принцесок.
- [updated] Прибрано префікс ps для всіх команд.
- [updated] Команда /cancel змінена на /leave.
- [updated] Адмінка боту вже не потрібна.
- [updated] Повний список гравців тепер також сортується за досягненнями, як й список топів.
- [removed] Префікс ps для всіх команд.

## 1.0.0 - 02.04.2020

### Major Changes

- [notes] Перша стабільна версія боту.
