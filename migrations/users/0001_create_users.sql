-- Migration number: 0001 	 2025-12-25T05:43:00.000Z
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    credential TEXT NOT NULL UNIQUE,
    refresh_token TEXT,
    refresh_token_expires_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);
