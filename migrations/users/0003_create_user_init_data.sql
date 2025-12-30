-- Migration number: 0003 	 2025-12-30T00:00:00.000Z
CREATE TABLE IF NOT EXISTS user_init_data (
    user_id TEXT PRIMARY KEY,
    source_language TEXT,
    target_language TEXT,
    why_use TEXT,
    how_to_known TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);
