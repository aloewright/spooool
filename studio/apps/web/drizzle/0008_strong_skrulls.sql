ALTER TABLE `blog_posts` ADD `draft_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chapters` ADD `draft_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `script_scenes` ADD `draft_version` integer DEFAULT 0 NOT NULL;