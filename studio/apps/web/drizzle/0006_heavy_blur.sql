ALTER TABLE `projects` ADD `logline` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `audience_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `voice_styles_json` text DEFAULT '[]' NOT NULL;