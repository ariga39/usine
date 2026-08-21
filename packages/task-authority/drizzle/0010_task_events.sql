CREATE TABLE `task_events` (
	`task_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`event_id` text NOT NULL,
	`occurred_at_epoch_ms` integer NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`task_id`, `sequence`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_events_task_id_event_id_index` ON `task_events` (`task_id`, `event_id`);
--> statement-breakpoint
INSERT INTO `task_events` (`task_id`, `sequence`, `event_id`, `occurred_at_epoch_ms`, `data`)
SELECT
	`task_id`,
	ROW_NUMBER() OVER (PARTITION BY `task_id` ORDER BY `id`),
	'legacy-history-' || `id`,
	`started_at_epoch_ms`,
	json_object(
		'type', 'legacy_observation',
		'kind', CASE WHEN `kind` IN ('implementer', 'project_check', 'fresh_review', 'forge_delivery', 'coordinator_restart', 'execution_owner_change') THEN `kind` ELSE 'unknown' END,
		'outcome', CASE WHEN `outcome` IN ('running', 'succeeded', 'failed', 'cancelled', 'blocked', 'observed') THEN `outcome` ELSE 'unknown' END,
		'complete', 0
	)
FROM `task_history`;
--> statement-breakpoint
INSERT INTO `task_events` (`task_id`, `sequence`, `event_id`, `occurred_at_epoch_ms`, `data`)
SELECT
	`task_id`,
	COUNT(*) + 1,
	'legacy-import-incomplete',
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	json_object('type', 'legacy_import_incomplete', 'importedCount', COUNT(*), 'complete', 0)
FROM `task_history`
GROUP BY `task_id`;
--> statement-breakpoint
INSERT INTO `task_events` (`task_id`, `sequence`, `event_id`, `occurred_at_epoch_ms`, `data`)
SELECT
	`task_id`,
	1,
	'legacy-import-incomplete',
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	json_object('type', 'legacy_import_incomplete', 'importedCount', 0, 'complete', 0)
FROM `task_runs`
WHERE `task_id` NOT IN (SELECT DISTINCT `task_id` FROM `task_history`);
