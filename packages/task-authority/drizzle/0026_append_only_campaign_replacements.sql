ALTER TABLE `campaign_replacement_runs` RENAME TO `campaign_replacement_runs_legacy`;
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
	PRIMARY KEY(`campaign_id`, `outcome_id`, `invocation_id`)
);
--> statement-breakpoint
INSERT INTO `campaign_replacement_runs` (
	`campaign_id`, `outcome_id`, `assessment_id`, `evidence_hash`, `invocation_id`, `role`,
	`status`, `proposal`, `usage`, `started_at_epoch_ms`, `completed_at_epoch_ms`
)
SELECT
	`campaign_id`, `outcome_id`, `assessment_id`, `evidence_hash`, `invocation_id`, `role`,
	`status`, `proposal`, `usage`, `started_at_epoch_ms`, `completed_at_epoch_ms`
FROM `campaign_replacement_runs_legacy`;
--> statement-breakpoint
DROP TABLE `campaign_replacement_runs_legacy`;
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_replacement_runs_invocation_index` ON `campaign_replacement_runs` (`invocation_id`);
