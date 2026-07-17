CREATE TABLE `ai_budget_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`usage_date` text NOT NULL,
	`fingerprint` text NOT NULL,
	`route` text NOT NULL,
	`reserved_cents` integer NOT NULL,
	`actual_cents` integer,
	`status` text NOT NULL,
	`revision_id` text,
	`response_json` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_budget_requests_by_user_day` ON `ai_budget_requests` (`user_id`,`usage_date`,`expires_at`);