ALTER TABLE `user_entitlements` ADD COLUMN `is_trial` integer DEFAULT 0;
ALTER TABLE `user_entitlements` ADD COLUMN `auto_renew` integer DEFAULT 1;
