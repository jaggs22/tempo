-- Small key/value store for app-level settings the Worker manages itself
-- (e.g. the Web Push VAPID key pair, generated on first use).
CREATE TABLE app_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
