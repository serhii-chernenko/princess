---
'princess': major
---

- [updated] Перенесено виконання бота на Cloudflare Workers із Telegram-вебхуком, а зберігання даних — до Cloudflare D1 через Drizzle ORM.
- [notes] Застарілий вихідний код попередньої реалізації поки що залишається в репозиторії для завершення перевірки міграції.
- [removed] Припинено розгортання через VPS, Docker та Ansible на користь Cloudflare Workers.
