CREATE TABLE `credit_purchases` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	`amount_seconds` integer NOT NULL,
	`created_at` integer NOT NULL,
	`source` text DEFAULT 'revenuecat'
);

CREATE TABLE `user_credits` (
	`user_id` text PRIMARY KEY,
	`balance_seconds` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
