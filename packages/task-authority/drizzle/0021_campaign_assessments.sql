CREATE TABLE `campaign_assessments` (
	`campaign_id` text NOT NULL,
	`outcome_id` text NOT NULL,
	`role` text DEFAULT 'assessor' NOT NULL,
	`evidence_hash` text NOT NULL,
	`assessment_id` text NOT NULL,
	`assessment` text NOT NULL,
	`started_at_epoch_ms` integer NOT NULL,
	`completed_at_epoch_ms` integer NOT NULL,
	PRIMARY KEY(`campaign_id`, `outcome_id`, `assessment_id`)
);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `assessment_requested` integer DEFAULT 0 NOT NULL;
