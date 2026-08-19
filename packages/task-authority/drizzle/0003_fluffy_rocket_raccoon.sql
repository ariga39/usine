CREATE TABLE `task_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`activation` integer,
	`cycle` integer,
	`role` text,
	`model` text,
	`started_at_epoch_ms` integer NOT NULL,
	`ended_at_epoch_ms` integer,
	`outcome` text NOT NULL,
	`failure` text,
	`candidate_sha` text,
	`candidate_fence` integer,
	`token_usage` text
);
--> statement-breakpoint
CREATE INDEX `task_history_task_id_id_index` ON `task_history` (`task_id`,`id`);