---
name: preview-bot
description: Test the current branch or PR with the Princess debug bot (@princess_debug_bot) by pointing its webhook at the branch Worker Preview. Use when the user wants to try a branch, PR or preview in Telegram with the debug or preview bot.
---

# Preview bot

Read `docs/OPERATIONS.md` section 6 first if you have not this session.

## Steps

1. Make sure HEAD is pushed. `pnpm preview:point` refuses an unpushed HEAD; if it is not, push the branch first.
2. Run `pnpm preview:point` and wait for it to finish. It waits for the Workers Builds check and for the preview to answer, then points the preview bot webhook at the branch preview. If the output contains `previousOrigin`, tell the user which preview the bot was taken from.
3. Tell the user exactly what to do in the preview-only Telegram group: send `/start`, then the command under test. State that the production bot must never be added to that group.
4. Offer `pnpm preview:smoke --chat-id <id>` only when the user gives a chat id. It sends a synthetic `/start` to the preview webhook and the bot may reply in that chat.
5. After the PR is merged, run `pnpm preview:reset` to point the preview bot back at the long-lived preview.

## Rules

- Never read or print `.dev.vars*` files.
- Never run `telegram:webhook:*` commands against production.
- Never point the preview bot at anything other than a `*-princess.chernenko.workers.dev` preview.
- Do not add both bots to the same Telegram group.
