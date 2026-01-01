-- Migration: Create text_classifications table
CREATE TABLE IF NOT EXISTS text_classifications (
    id TEXT PRIMARY KEY,
    text_hash TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL,
    classification_type TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_text_classifications_hash ON text_classifications(text_hash);
