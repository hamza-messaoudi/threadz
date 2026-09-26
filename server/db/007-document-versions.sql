-- Every version of a shared document, so an edit (the user's or an agent's) can be seen and undone.
-- The document message's content_md is always the latest version; version 1 is written on the first edit.
CREATE TABLE document_versions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_md TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent')),
  author_id TEXT,                    -- agent name
  thread_id TEXT,                    -- the thread an agent edited from
  restored_from INTEGER,             -- set when this version brings back an older one
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, version)
);
-- A side thread on a document passage that an edit changed ('changed': re-anchored to what replaced it)
-- or removed ('removed': detached, block_index/block_end < 0). anchor_version is the edit that did it.
ALTER TABLE threads ADD COLUMN anchor TEXT;
ALTER TABLE threads ADD COLUMN anchor_version INTEGER;
-- The version of each shared document a session has read, as JSON {message id: version}. NULL on sessions
-- from before documents could change: they read version 1.
ALTER TABLE agent_sessions ADD COLUMN doc_versions TEXT;
-- A reader session has read one version of its document; after an edit it is not forked any more.
ALTER TABLE document_sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
