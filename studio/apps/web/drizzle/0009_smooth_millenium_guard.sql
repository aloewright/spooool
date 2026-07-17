ALTER TABLE `blog_posts` ADD `draft_session_id` text;--> statement-breakpoint
ALTER TABLE `blog_posts` ADD `draft_sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chapters` ADD `draft_session_id` text;--> statement-breakpoint
ALTER TABLE `chapters` ADD `draft_sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `script_scenes` ADD `draft_session_id` text;--> statement-breakpoint
ALTER TABLE `script_scenes` ADD `draft_sequence` integer DEFAULT 0 NOT NULL;