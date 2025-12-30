CREATE TABLE `user_usage_stats` (
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`period_type` text NOT NULL,
	`period_value` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`duration_seconds` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now') * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `endpoint`, `period_type`, `period_value`)
);
