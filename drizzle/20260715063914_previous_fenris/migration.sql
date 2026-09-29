CREATE TABLE `telegram_updates` (
	`bot_key` text NOT NULL,
	`update_id` integer NOT NULL,
	`status` text NOT NULL,
	`lease_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`processed_at` integer,
	CONSTRAINT "telegram_updates_status_check" CHECK("status" in ('processing', 'processed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_updates_bot_update_unique` ON `telegram_updates` (`bot_key`,`update_id`);--> statement-breakpoint
CREATE INDEX `telegram_updates_cleanup_index` ON `telegram_updates` (`status`,`processed_at`);