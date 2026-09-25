-- A shared document's reader session per (agent, cwd): a Claude session that has read the whole document
-- once, in a short turn of its own. Side threads on the document fork it, so each thread starts with the
-- document already in its cached prefix instead of sending (and cache-writing) it again.
CREATE TABLE document_sessions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  claude_session_id TEXT NOT NULL,
  flags_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, agent_id, cwd)
);
