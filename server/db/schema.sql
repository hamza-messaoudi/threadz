CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('channel','chat','routine')),
  name TEXT NOT NULL,
  dir TEXT,                          -- NULL = scratchDir
  yolo INTEGER NOT NULL DEFAULT 0,   -- sticky per conversation
  routine_id TEXT,                   -- set when kind = 'routine'
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  parent_thread_id TEXT REFERENCES threads(id),   -- NULL = root thread
  parent_message_id TEXT REFERENCES messages(id),
  block_index INTEGER,
  block_text TEXT,                   -- snapshot of the paragraph
  created_at INTEGER NOT NULL,
  UNIQUE (parent_message_id, block_index)          -- one thread per paragraph
);
CREATE INDEX threads_conversation ON threads(conversation_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,               -- ULID, sortable
  thread_id TEXT NOT NULL REFERENCES threads(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','system')),
  author_id TEXT,                    -- agent name, workflow name or NULL
  content_md TEXT NOT NULL DEFAULT '',
  tool_events TEXT,                  -- JSON array of {id, name, input, output_preview, denied, is_error}
  status TEXT NOT NULL CHECK (status IN ('queued','streaming','done','error','cancelled')),
  error TEXT,
  usage TEXT,                        -- JSON from the result event (+ first_call)
  run_id TEXT,
  done_seq INTEGER UNIQUE,           -- monotonic, assigned when status becomes done
  created_at INTEGER NOT NULL,
  cwd TEXT,                          -- agent messages: working directory of the turn
  session_id TEXT,                   -- agent messages: Claude session used
  markers TEXT,                      -- JSON array of strings shown above the message
  mentions TEXT,                     -- user messages: JSON mentions
  meta TEXT                          -- JSON: {kind: 'workflow_card'|'workflow_step'|'run_header', ...}
);
CREATE INDEX messages_thread ON messages(thread_id, id);

CREATE TABLE agent_sessions (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  agent_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  claude_session_id TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL DEFAULT 0,  -- delta cursor over messages.done_seq
  flags_hash TEXT NOT NULL,          -- hash of spawn flags; mismatch = new session
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, agent_id, cwd)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('turn','workflow','routine')),
  status TEXT NOT NULL,
  parent_run_id TEXT,
  started_at INTEGER, finished_at INTEGER, error TEXT,
  thread_id TEXT,
  meta TEXT
);

CREATE TABLE routine_state (
  routine_id TEXT PRIMARY KEY,
  last_success_slot INTEGER,         -- the scheduled slot that last succeeded
  last_attempt_at INTEGER,
  last_error TEXT
);

CREATE TABLE dirs_recent (path TEXT PRIMARY KEY, used_at INTEGER NOT NULL);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content_md, content='messages', content_rowid='rowid'
);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content_md) VALUES (new.rowid, new.content_md);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_md) VALUES ('delete', old.rowid, old.content_md);
END;
CREATE TRIGGER messages_au AFTER UPDATE OF content_md ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_md) VALUES ('delete', old.rowid, old.content_md);
  INSERT INTO messages_fts(rowid, content_md) VALUES (new.rowid, new.content_md);
END;
