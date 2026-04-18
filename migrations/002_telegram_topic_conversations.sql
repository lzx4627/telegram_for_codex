ALTER TABLE remote_agent_conversations
  ADD COLUMN platform_chat_id BIGINT,
  ADD COLUMN platform_thread_id BIGINT,
  ADD COLUMN topic_name VARCHAR(255);

CREATE INDEX idx_remote_agent_conversations_platform_chat_thread
  ON remote_agent_conversations(platform_type, platform_chat_id, platform_thread_id);
