ALTER TABLE user_entitlements ADD COLUMN original_app_user_id text;
CREATE INDEX IF NOT EXISTS idx_user_entitlements_original_app_user_id ON user_entitlements (original_app_user_id);
