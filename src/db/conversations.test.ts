jest.mock('./connection', () => ({
  pool: {
    query: jest.fn(),
  },
}));

import { pool } from './connection';
import { getOrCreateConversation, listConversationsByChatId } from './conversations';

describe('conversations db', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('creates a Telegram topic conversation with chat and thread metadata', async () => {
    (pool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'conv-1',
            platform_type: 'telegram',
            platform_conversation_id: 'telegram:-1001234567890:42',
            platform_chat_id: '-1001234567890',
            platform_thread_id: 42,
            topic_name: 'repo-a',
            codebase_id: null,
            cwd: null,
            ai_assistant_type: 'codex',
          },
        ],
      });

    const conversation = await getOrCreateConversation({
      platformType: 'telegram',
      conversationId: 'telegram:-1001234567890:42',
      chatId: '-1001234567890',
      threadId: 42,
      topicName: 'repo-a',
    });

    expect(conversation.platform_thread_id).toBe(42);
    expect((pool.query as jest.Mock).mock.calls[1][1]).toEqual([
      'telegram',
      'telegram:-1001234567890:42',
      '-1001234567890',
      42,
      'repo-a',
      'codex',
    ]);
  });

  test('lists all business topics for one Telegram group', async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({
      rows: [
        { id: 'conv-1', platform_thread_id: 42, topic_name: 'repo-a', cwd: '/tmp/repo-a' },
        { id: 'conv-2', platform_thread_id: 77, topic_name: 'repo-b', cwd: '/tmp/repo-b' },
      ],
    });

    const conversations = await listConversationsByChatId('telegram', '-1001234567890');

    expect(conversations).toHaveLength(2);
    expect((pool.query as jest.Mock).mock.calls[0][1]).toEqual(['telegram', '-1001234567890']);
  });
});
