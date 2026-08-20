ALTER TABLE `repositories` ADD `implementer_profile` text NOT NULL DEFAULT 'implementer';
--> statement-breakpoint
ALTER TABLE `repositories` ADD `reviewer_profile` text NOT NULL DEFAULT 'reviewer';
--> statement-breakpoint
ALTER TABLE `task_history` ADD `profile` text;
--> statement-breakpoint
ALTER TABLE `task_history` ADD `observed_model` text;
--> statement-breakpoint
ALTER TABLE `task_history` ADD `observed_provider` text;
--> statement-breakpoint
ALTER TABLE `task_history` DROP COLUMN `model`;
