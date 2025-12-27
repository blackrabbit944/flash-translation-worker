CREATE TABLE `tts_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`text` text NOT NULL,
	`cost_micros` integer NOT NULL,
	`text_hash` text NOT NULL,
	`voice_name` text NOT NULL,
	`model_name` text NOT NULL,
	`url` text,
	`created_at` integer NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);
