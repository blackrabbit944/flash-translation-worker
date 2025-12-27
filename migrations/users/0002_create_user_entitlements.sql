-- Create user_entitlements table to store subscription status
CREATE TABLE user_entitlements (
    user_id TEXT NOT NULL,
    entitlement_id TEXT NOT NULL,
    expires_at INTEGER, -- Timestamp in milliseconds, null means lifetime/unknown
    status TEXT NOT NULL, -- 'active', 'expired', etc.
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    PRIMARY KEY (user_id, entitlement_id)
);
