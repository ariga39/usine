CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`base_branch` text NOT NULL,
	`project_check_command` text NOT NULL,
	`project_check_timeout_ms` integer NOT NULL,
	`git_author_name` text NOT NULL,
	`git_author_email` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
