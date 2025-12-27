-- Optimize index for rate limiting queries
-- Used by getUsageStats for (userId, endpoint, createdAt >= startOfMonth)
CREATE INDEX idx_usage_logs_user_endpoint_created ON usage_logs (user_id, endpoint, created_at);
