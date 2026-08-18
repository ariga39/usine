CREATE TABLE `repository_leases` (
	`repository_identity` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`generation` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `repository_leases_task_id_unique` UNIQUE(`task_id`)
);
--> statement-breakpoint
CREATE TABLE `task_runs` (
	`task_id` text PRIMARY KEY NOT NULL,
	`contract_hash` text NOT NULL,
	`contract` text NOT NULL,
	`repository` text NOT NULL,
	`state` text NOT NULL,
	`writer_generation` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`result` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
