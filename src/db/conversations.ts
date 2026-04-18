/**
 * Database operations for conversations
 */
import { pool } from './connection';
import { Conversation } from '../types';

interface TopicConversationInput {
  platformType: string;
  conversationId: string;
  chatId: string | null;
  threadId: number | null;
  topicName?: string | null;
  codebaseId?: string;
}

function isTopicConversationInput(
  value: string | TopicConversationInput
): value is TopicConversationInput {
  return typeof value !== 'string';
}

export async function getOrCreateConversation(
  input: TopicConversationInput
): Promise<Conversation>;
export async function getOrCreateConversation(
  platformType: string,
  platformId: string,
  codebaseId?: string
): Promise<Conversation>;
export async function getOrCreateConversation(
  inputOrPlatformType: string | TopicConversationInput,
  platformId?: string,
  codebaseId?: string
): Promise<Conversation> {
  const input = isTopicConversationInput(inputOrPlatformType)
    ? inputOrPlatformType
    : {
        platformType: inputOrPlatformType,
        conversationId: platformId!,
        chatId: null,
        threadId: null,
        topicName: null,
        codebaseId,
      };

  const existing = await pool.query<Conversation>(
    'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
    [input.platformType, input.conversationId]
  );

  if (existing.rows[0]) {
    if (!existing.rows[0].topic_name && input.topicName) {
      await pool.query(
        'UPDATE remote_agent_conversations SET topic_name = $1, updated_at = NOW() WHERE id = $2',
        [input.topicName, existing.rows[0].id]
      );
      existing.rows[0].topic_name = input.topicName;
    }
    return existing.rows[0];
  }

  // Determine assistant type from codebase or environment
  let assistantType = process.env.DEFAULT_AI_ASSISTANT || 'claude';
  if (input.platformType === 'telegram') {
    assistantType = 'codex';
  }
  if (input.codebaseId) {
    const codebase = await pool.query<{ ai_assistant_type: string }>(
      'SELECT ai_assistant_type FROM remote_agent_codebases WHERE id = $1',
      [input.codebaseId]
    );
    if (codebase.rows[0]) {
      assistantType = codebase.rows[0].ai_assistant_type;
    }
  }

  const created = await pool.query<Conversation>(
    `INSERT INTO remote_agent_conversations (
      platform_type,
      platform_conversation_id,
      platform_chat_id,
      platform_thread_id,
      topic_name,
      ai_assistant_type
    ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      input.platformType,
      input.conversationId,
      input.chatId,
      input.threadId,
      input.topicName ?? null,
      assistantType,
    ]
  );

  return created.rows[0];
}

export async function listConversationsByChatId(
  platformType: string,
  chatId: string
): Promise<Conversation[]> {
  const result = await pool.query<Conversation>(
    `SELECT *
       FROM remote_agent_conversations
      WHERE platform_type = $1
        AND platform_chat_id = $2
        AND platform_thread_id IS NOT NULL
      ORDER BY platform_thread_id ASC`,
    [platformType, chatId]
  );

  return result.rows;
}

export async function updateConversation(
  id: string,
  updates: Partial<Pick<Conversation, 'codebase_id' | 'cwd'>>
): Promise<void> {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  let i = 1;

  if (updates.codebase_id !== undefined) {
    fields.push(`codebase_id = $${i++}`);
    values.push(updates.codebase_id);
  }
  if (updates.cwd !== undefined) {
    fields.push(`cwd = $${i++}`);
    values.push(updates.cwd);
  }

  if (fields.length === 0) {
    return; // No updates
  }

  fields.push('updated_at = NOW()');
  values.push(id);

  await pool.query(
    `UPDATE remote_agent_conversations SET ${fields.join(', ')} WHERE id = $${i}`,
    values
  );
}
