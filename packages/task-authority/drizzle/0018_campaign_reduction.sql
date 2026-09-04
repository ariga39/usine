ALTER TABLE `campaigns` ADD `plan_handed_off` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `decision_request` text;
