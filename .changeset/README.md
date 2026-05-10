# Changeset Rules

Use Ukrainian tagged bullets in every changeset body:

- `[added]` for new user-facing features
- `[updated]` for behavior changes or copy updates
- `[fixed]` for bug fixes
- `[removed]` for removals
- `[notes]` for announcements or extra context

Example:

```md
---
'princess': patch
---

- [fixed] Виправлено обробку вебхука в Cloudflare Workers.
- [updated] Оновлено тексти довідки для нового оточення.
```

`pnpm run changeset:validate` enforces this format.
