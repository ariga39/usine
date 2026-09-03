CREATE TABLE `campaigns` (
	`campaign_id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`goal_version` integer NOT NULL,
	`contract_hash` text NOT NULL,
	`contract` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaigns_goal_identity_index` ON `campaigns` (`goal_id`,`goal_version`);
