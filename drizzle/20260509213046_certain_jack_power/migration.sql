CREATE TABLE `channel_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`channel_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`is_auto_joined` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_channel_members_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_channel_members_player_id_players_id_fk` FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON DELETE CASCADE,
	CONSTRAINT "channel_members_score_non_negative" CHECK("score" >= 0)
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`telegram_chat_id` integer NOT NULL,
	`release_version` text NOT NULL,
	`last_vote_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `players` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`telegram_user_id` integer NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_members_channel_player_unique` ON `channel_members` (`channel_id`,`player_id`);--> statement-breakpoint
CREATE INDEX `channel_members_channel_id_index` ON `channel_members` (`channel_id`);--> statement-breakpoint
CREATE INDEX `channel_members_player_id_index` ON `channel_members` (`player_id`);--> statement-breakpoint
CREATE INDEX `channel_members_active_index` ON `channel_members` (`channel_id`,`is_active`);--> statement-breakpoint
CREATE INDEX `channel_members_score_index` ON `channel_members` (`channel_id`,`score`);--> statement-breakpoint
CREATE UNIQUE INDEX `channels_telegram_chat_id_unique` ON `channels` (`telegram_chat_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `players_telegram_user_id_unique` ON `players` (`telegram_user_id`);