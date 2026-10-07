PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS line_users (
  line_user_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT NOT NULL UNIQUE REFERENCES line_users(line_user_id),
  mode TEXT NOT NULL DEFAULT 'BOT' CHECK (mode IN ('BOT', 'HUMAN')),
  current_step TEXT NOT NULL DEFAULT 'serviceType',
  handoff_reason TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT', 'INTERNAL')),
  message_type TEXT NOT NULL,
  body TEXT NOT NULL,
  event_id TEXT REFERENCES webhook_events(event_id),
  reply_token TEXT,
  send_status TEXT NOT NULL DEFAULT 'SENT' CHECK (send_status IN ('PENDING', 'SENDING', 'SENT', 'CANCELLED', 'UNKNOWN')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  allow_human_mode INTEGER NOT NULL DEFAULT 0 CHECK (allow_human_mode IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_event_direction ON messages(event_id, direction);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations(id),
  status TEXT NOT NULL DEFAULT 'NEW',
  requirements_json TEXT NOT NULL DEFAULT '{}',
  source TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS message_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  UNIQUE (message_key, revision)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_username TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rich_menu_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_menu_id TEXT,
  image_uploaded INTEGER NOT NULL DEFAULT 0 CHECK (image_uploaded IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'CREATING', 'PUBLISHED', 'FAILED', 'REPLACED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS staff_users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS staff_sessions (
  session_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES staff_users(username),
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_updated ON leads(updated_at);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
