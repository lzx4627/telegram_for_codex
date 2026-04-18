jest.mock('../db/conversations', () => ({
  listConversationsByChatId: jest.fn(),
}));

import { ConversationLockManager } from '../utils/conversation-lock';
import * as conversationDb from '../db/conversations';
import { handleGeneralTopicCommand } from './general-topic-handler';

describe('general topic handler', () => {
  test('creates a new Telegram topic and tells the user to bind a path', async () => {
    const adapter = {
      createTopic: jest.fn().mockResolvedValue({ threadId: 77, name: 'repo-a' }),
    };

    const result = await handleGeneralTopicCommand(
      adapter as never,
      {
        platformType: 'telegram',
        conversationId: 'telegram:-1001234567890:general',
        chatId: '-1001234567890',
        threadId: null,
        topicName: null,
        isGeneral: true,
        isBusinessTopic: false,
      },
      '/topic repo-a',
      { lockManager: new ConversationLockManager(10) }
    );

    expect(adapter.createTopic).toHaveBeenCalledWith('-1001234567890', 'repo-a');
    expect(result.message).toContain("Created topic 'repo-a'");
    expect(result.message).toContain('/bind /absolute/path');
  });

  test('lists business topics for the Telegram group', async () => {
    (conversationDb.listConversationsByChatId as jest.Mock).mockResolvedValue([
      {
        id: 'conv-1',
        platform_type: 'telegram',
        platform_conversation_id: 'telegram:-1001234567890:42',
        platform_chat_id: '-1001234567890',
        platform_thread_id: 42,
        topic_name: 'repo-a',
        codebase_id: null,
        cwd: '/tmp/repo-a',
        ai_assistant_type: 'codex',
      },
    ]);

    const runtime = { lockManager: new ConversationLockManager(10) };
    jest.spyOn(runtime.lockManager, 'getConversationState').mockReturnValue({
      state: 'idle',
      isActive: false,
      queueLength: 0,
    });

    const result = await handleGeneralTopicCommand(
      { createTopic: jest.fn() } as never,
      {
        platformType: 'telegram',
        conversationId: 'telegram:-1001234567890:general',
        chatId: '-1001234567890',
        threadId: null,
        topicName: null,
        isGeneral: true,
        isBusinessTopic: false,
      },
      '/topics',
      runtime
    );

    expect(result.message).toContain('repo-a');
    expect(result.message).toContain('/tmp/repo-a');
    expect(result.message).toContain('idle');
  });
});
