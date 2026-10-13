CREATE TABLE `proposal_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`chat_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`prompt_message_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_requests_chat_user_unique` ON `proposal_requests` (`chat_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `proposal_requests_created_at_index` ON `proposal_requests` (`created_at`);