-- A thread can quote a run of blocks: block_index is the first, block_end the last (equal for one paragraph).
-- UNIQUE moves from (message, block) to (message, first, last), which needs a table rebuild.
CREATE TABLE threads_new (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  parent_thread_id TEXT REFERENCES threads(id),   -- NULL = root thread
  parent_message_id TEXT REFERENCES messages(id),
  block_index INTEGER,               -- first quoted block
  block_end INTEGER,                 -- last quoted block (inclusive)
  block_text TEXT,                   -- snapshot of the quoted blocks
  created_at INTEGER NOT NULL,
  UNIQUE (parent_message_id, block_index, block_end) -- one thread per passage
);
INSERT INTO threads_new (id, conversation_id, parent_thread_id, parent_message_id, block_index, block_end, block_text, created_at)
  SELECT id, conversation_id, parent_thread_id, parent_message_id, block_index, block_index, block_text, created_at FROM threads;
DROP TABLE threads;
ALTER TABLE threads_new RENAME TO threads;
CREATE INDEX threads_conversation ON threads(conversation_id);
