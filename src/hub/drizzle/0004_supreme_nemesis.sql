CREATE TABLE `blog_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`blog_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`draft_md` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`emdash_post_id` text,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`blog_id`) REFERENCES `blogs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `blog_posts_by_blog` ON `blog_posts` (`blog_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `blogs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`format` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`audience_json` text DEFAULT '[]' NOT NULL,
	`voice_links_json` text DEFAULT '[]' NOT NULL,
	`voice_uploads_json` text DEFAULT '[]' NOT NULL,
	`voice_profile_md` text DEFAULT '' NOT NULL,
	`rules_do_json` text DEFAULT '[]' NOT NULL,
	`rules_dont_json` text DEFAULT '[]' NOT NULL,
	`structure` text,
	`planned_posts` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'concept' NOT NULL,
	`emdash_site` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `blogs_by_user` ON `blogs` (`user_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `emdash_token_ciphertext` blob;--> statement-breakpoint
ALTER TABLE `users` ADD `emdash_token_iv` blob;