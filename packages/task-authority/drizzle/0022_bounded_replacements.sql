ALTER TABLE `campaign_proposals` ADD `replacement_assessment_id` text;
--> statement-breakpoint
ALTER TABLE `campaign_proposals` ADD `replacement_evidence_hash` text;
--> statement-breakpoint
ALTER TABLE `campaign_proposals` ADD `replacement_usage` text;
--> statement-breakpoint
CREATE TABLE `campaign_replacement_runs` (
	`campaign_id` text NOT NULL,
	`outcome_id` text NOT NULL,
	`assessment_id` text NOT NULL,
	`evidence_hash` text NOT NULL,
	`invocation_id` text NOT NULL,
	`role` text DEFAULT 'replacement-planner' NOT NULL,
	`status` text NOT NULL,
	`proposal` text,
	`usage` text,
	`started_at_epoch_ms` integer NOT NULL,
	`completed_at_epoch_ms` integer,
	PRIMARY KEY(`campaign_id`, `outcome_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_replacement_runs_invocation_index` ON `campaign_replacement_runs` (`invocation_id`);
