CREATE TABLE `task_quarantines` (
	`task_id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`result` text NOT NULL,
	`contract_path` text,
	`repository_path` text,
	`raw_contract` text,
	`quarantined_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `task_quarantines` (`task_id`, `reason`, `result`, `contract_path`, `repository_path`, `raw_contract`)
SELECT `task_id`, 'repository registration required', `result`, `contract_path`, `repository_path`, `raw_contract`
FROM `task_runs`
WHERE json_type(`result`, '$.repository') IS NULL;
--> statement-breakpoint
DELETE FROM `repository_leases`
WHERE `task_id` IN (SELECT `task_id` FROM `task_quarantines`);
--> statement-breakpoint
DELETE FROM `task_runs`
WHERE `task_id` IN (SELECT `task_id` FROM `task_quarantines`);
