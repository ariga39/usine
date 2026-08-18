PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_repository_leases` (
	`repository_identity` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_repository_leases` (`repository_identity`, `task_id`, `created_at`)
SELECT `repository_identity`, `task_id`, `created_at` FROM `repository_leases`;--> statement-breakpoint
DROP TABLE `repository_leases`;--> statement-breakpoint
ALTER TABLE `__new_repository_leases` RENAME TO `repository_leases`;--> statement-breakpoint
CREATE UNIQUE INDEX `repository_leases_task_id_unique` ON `repository_leases` (`task_id`);--> statement-breakpoint
CREATE TABLE `__new_task_runs` (
	`task_id` text PRIMARY KEY NOT NULL,
	`result` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_task_runs` (`task_id`, `result`, `created_at`, `updated_at`)
SELECT
	`task_id`,
	CASE
		WHEN json_type(`result`, '$.deadlineEpochMs') IS NULL
			THEN json_set(json_remove(`result`, '$.writer.generation'), '$.deadlineEpochMs', `deadline_at`)
		ELSE json_remove(`result`, '$.writer.generation')
	END,
	`created_at`,
	`updated_at`
FROM `task_runs`;--> statement-breakpoint
DROP TABLE `task_runs`;--> statement-breakpoint
ALTER TABLE `__new_task_runs` RENAME TO `task_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
