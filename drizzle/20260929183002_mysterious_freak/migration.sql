CREATE TABLE `release_announcements` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`release_version` text NOT NULL,
	`channel_id` integer NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error_code` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_release_announcements_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE CASCADE,
	CONSTRAINT "release_announcements_status_check" CHECK("status" in ('queued', 'sending', 'sent', 'skipped', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_announcements_version_channel_unique` ON `release_announcements` (`release_version`,`channel_id`);--> statement-breakpoint
CREATE INDEX `release_announcements_channel_id_index` ON `release_announcements` (`channel_id`);