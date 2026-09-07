CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`channel` text NOT NULL,
	`agent` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_entries_created_at` ON `entries` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_entries_kind_created_at` ON `entries` (`kind`,`created_at`);