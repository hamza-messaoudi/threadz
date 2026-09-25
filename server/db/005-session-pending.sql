-- Context a resumed session still has to be told, sent once ahead of its next turn and then cleared.
-- Set when side threads merge: the kept session learns the wider passage and the replies it never saw,
-- as appended text, so its cached prefix stays valid.
ALTER TABLE agent_sessions ADD COLUMN pending TEXT;
