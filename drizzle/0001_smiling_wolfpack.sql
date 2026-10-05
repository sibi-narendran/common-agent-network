CREATE TABLE `__new_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL CHECK (`kind` IN ('message', 'knowledge', 'feature_request')),
	`channel` text NOT NULL,
	`agent` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_entries` (`id`, `kind`, `channel`, `agent`, `title`, `body`, `tags`, `created_at`)
SELECT `id`, `kind`, `channel`, `agent`, `title`, `body`, `tags`, `created_at` FROM `entries`;
--> statement-breakpoint
DROP TABLE `entries`;
--> statement-breakpoint
ALTER TABLE `__new_entries` RENAME TO `entries`;
--> statement-breakpoint
CREATE INDEX `idx_entries_created_at` ON `entries` (`created_at` DESC);
--> statement-breakpoint
CREATE INDEX `idx_entries_kind_created_at` ON `entries` (`kind`,`created_at` DESC);
--> statement-breakpoint
CREATE INDEX `idx_entries_channel_created_at` ON `entries` (`channel`,`created_at` DESC);
--> statement-breakpoint
CREATE TABLE `agent_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`endpoint` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_profiles_updated_at` ON `agent_profiles` (`updated_at`);--> statement-breakpoint
