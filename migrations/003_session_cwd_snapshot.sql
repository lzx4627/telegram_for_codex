ALTER TABLE remote_agent_sessions
  ADD COLUMN cwd_snapshot VARCHAR(500);

UPDATE remote_agent_sessions s
SET cwd_snapshot = c.cwd
FROM remote_agent_conversations c
WHERE c.id = s.conversation_id
  AND s.cwd_snapshot IS NULL;

CREATE INDEX idx_remote_agent_sessions_cwd_snapshot
  ON remote_agent_sessions(cwd_snapshot, ai_assistant_type, started_at DESC);
