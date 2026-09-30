CREATE TABLE `channel_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`telegram_chat_id` integer NOT NULL,
	`reason` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "channel_snapshots_reason_check" CHECK("reason" in ('reset', 'forget', 'restore'))
);
--> statement-breakpoint
ALTER TABLE `channels` ADD `stopped_at` integer;--> statement-breakpoint
CREATE INDEX `channel_snapshots_chat_created_at_index` ON `channel_snapshots` (`telegram_chat_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `channel_snapshots_expires_at_index` ON `channel_snapshots` (`expires_at`);