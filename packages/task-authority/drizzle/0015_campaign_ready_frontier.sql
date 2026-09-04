ALTER TABLE `repositories` ADD `head_sha` text;
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `publication_authorized` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `superseded` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `campaign_proposals` (
	`campaign_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`outcome_id` text NOT NULL,
	`proposal` text NOT NULL,
	`status` text NOT NULL,
	`blocker` text,
	`ready_base_sha` text,
	`ready_repository_revision` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`campaign_id`, `proposal_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_proposals_campaign_order_index` ON `campaign_proposals` (`campaign_id`,`sequence`);
