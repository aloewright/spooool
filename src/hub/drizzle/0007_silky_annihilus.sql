CREATE TABLE `script_scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`script_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`draft_json` text,
	`draft_md` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`script_id`) REFERENCES `scripts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `script_scenes_by_script` ON `script_scenes` (`script_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`format` text NOT NULL,
	`logline` text DEFAULT '' NOT NULL,
	`genre` text,
	`structure` text,
	`planned_scenes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'concept' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scripts_by_user` ON `scripts` (`user_id`);