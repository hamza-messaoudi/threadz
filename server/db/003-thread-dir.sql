-- Where a thread's untagged turns run after a "move into" (#dir chip set to move). NULL = inherit:
-- a side thread follows its source message, the main thread follows the conversation.
ALTER TABLE threads ADD COLUMN dir TEXT;
