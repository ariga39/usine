CREATE TABLE `posthog_capture_acknowledgements` (
	`deployment` text NOT NULL,
	`event_uuid` text NOT NULL,
	PRIMARY KEY(`deployment`, `event_uuid`)
);
