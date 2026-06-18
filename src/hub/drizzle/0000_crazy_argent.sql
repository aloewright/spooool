CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `chapters` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`target_words` integer DEFAULT 2400 NOT NULL,
	`draft_json` text,
	`draft_md` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chapters_by_project` ON `chapters` (`project_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`role` text NOT NULL,
	`content_json` text NOT NULL,
	`model` text,
	`route` text,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_messages_by_project` ON `chat_messages` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `dataset_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`week_iso` text NOT NULL,
	`r2_key` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dataset_snapshots_week_iso_unique` ON `dataset_snapshots` (`week_iso`);--> statement-breakpoint
CREATE TABLE `gtm_briefs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content_json` text NOT NULL,
	`brief_md` text NOT NULL,
	`r2_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `market_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`query_id` text NOT NULL,
	`dataset_snapshot_id` text NOT NULL,
	`summary_md` text NOT NULL,
	`evidence_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`query_id`) REFERENCES `market_queries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dataset_snapshot_id`) REFERENCES `dataset_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `market_queries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text,
	`niche` text NOT NULL,
	`type` text NOT NULL,
	`params_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `outlines` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`framework` text NOT NULL,
	`structure_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`genre` text,
	`status` text DEFAULT 'concept' NOT NULL,
	`voice_id` text,
	`target_word_count` integer DEFAULT 50000 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voice_id`) REFERENCES `voices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `projects_by_user` ON `projects` (`user_id`);--> statement-breakpoint
CREATE TABLE `publisher_packs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text DEFAULT '' NOT NULL,
	`description_html` text DEFAULT '' NOT NULL,
	`keywords_json` text DEFAULT '[]' NOT NULL,
	`bisac_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `render_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`workflow_id` text,
	`output_r2_key` text,
	`error` text,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `render_jobs_by_project` ON `render_jobs` (`project_id`);--> statement-breakpoint
CREATE TABLE `revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`target_table` text NOT NULL,
	`target_id` text NOT NULL,
	`before_md` text NOT NULL,
	`after_md` text NOT NULL,
	`llm_response` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `revisions_by_target` ON `revisions` (`target_table`,`target_id`);--> statement-breakpoint
CREATE TABLE `sections` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`draft_md` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sections_by_chapter` ON `sections` (`chapter_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`token` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `usage_daily` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`day_iso` text NOT NULL,
	`route` text NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `usage_daily_by_user_day` ON `usage_daily` (`user_id`,`day_iso`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer DEFAULT false NOT NULL,
	`image` text,
	`plan` text DEFAULT 'pro' NOT NULL,
	`phase` text DEFAULT 'chassis' NOT NULL,
	`daily_budget_cents` integer DEFAULT 5000 NOT NULL,
	`elevenlabs_key_ciphertext` blob,
	`elevenlabs_key_iv` blob,
	`stripe_customer_id` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `voice_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`voice_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`source` text NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`voice_id`) REFERENCES `voices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `voice_samples_by_voice` ON `voice_samples` (`voice_id`);--> statement-breakpoint
CREATE TABLE `voices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`postpilot_slug` text,
	`profile_md` text DEFAULT '' NOT NULL,
	`profile_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
