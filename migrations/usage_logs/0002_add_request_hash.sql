ALTER TABLE usage_logs ADD COLUMN request_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_logs_request_hash ON usage_logs(request_hash);
