ALTER TABLE `task_events` ADD `server_cursor` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `task_events`
SET `server_cursor` = (
  SELECT COUNT(*)
  FROM `task_events` AS prior
  WHERE prior.`task_id` < `task_events`.`task_id`
     OR (prior.`task_id` = `task_events`.`task_id` AND prior.`sequence` <= `task_events`.`sequence`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_events_server_cursor_index` ON `task_events` (`server_cursor`);
