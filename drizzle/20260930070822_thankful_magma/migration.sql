CREATE TABLE `vote_wins` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`channel_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	`won_at` integer NOT NULL,
	`mode` text NOT NULL,
	`eligible_count` integer NOT NULL,
	CONSTRAINT `fk_vote_wins_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_vote_wins_player_id_players_id_fk` FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON DELETE CASCADE,
	CONSTRAINT "vote_wins_mode_check" CHECK("mode" in ('auto', 'manual', 'sudo')),
	CONSTRAINT "vote_wins_eligible_count_check" CHECK("eligible_count" >= 2)
);
--> statement-breakpoint
CREATE INDEX `vote_wins_channel_won_at_index` ON `vote_wins` (`channel_id`,`won_at`);