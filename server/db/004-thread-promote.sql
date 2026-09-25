-- A side thread turned into its own channel becomes that channel's root thread (parent_thread_id NULL,
-- same id, so its agent sessions resume untouched). origin_thread_id keeps the thread it was opened from,
-- and parent_message_id / block_* keep the passage, so the source still links to the new channel.
ALTER TABLE threads ADD COLUMN origin_thread_id TEXT REFERENCES threads(id);
CREATE INDEX threads_origin ON threads(origin_thread_id) WHERE origin_thread_id IS NOT NULL;
