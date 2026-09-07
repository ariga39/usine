ALTER TABLE `campaigns` ADD `checkpoint_requested` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `campaign_proposals` ADD `superseded_by_proposal_id` text;
--> statement-breakpoint
ALTER TABLE `campaign_proposals` ADD `supersedes_proposal_id` text;
