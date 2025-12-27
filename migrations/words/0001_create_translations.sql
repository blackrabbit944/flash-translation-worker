-- Create translations table for caching
CREATE TABLE translations (
    id TEXT PRIMARY KEY,
    source_text_hash TEXT NOT NULL,
    source_text TEXT NOT NULL,
    source_lang TEXT NOT NULL,
    target_lang TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX idx_translations_hash_lang ON translations (source_text_hash, source_lang, target_lang);
