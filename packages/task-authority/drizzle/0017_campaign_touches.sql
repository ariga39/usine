CREATE TABLE `campaign_touches` (
	`campaign_id` text NOT NULL,
	`touch_id` text NOT NULL,
	`goal_version` integer NOT NULL,
	`type` text NOT NULL,
	`occurred_at_epoch_ms` integer NOT NULL,
	PRIMARY KEY(`campaign_id`, `touch_id`)
);
