jest.mock('../db/conversations', () => ({
  listConversationsByChatId: jest.fn(),
}));

jest.mock('../clients/codex', () => ({
  getCodexStatusProfile: jest.fn(() => ({
    model: 'gpt-5.4',
    configuredReasoningEffort: 'high',
    effectiveReasoningEffort: 'high',
  })),
  normalizeCodexModel: jest.fn((value: string) =>
    ['gpt-5.5', 'gpt-5.4'].includes(value) ? value : undefined
  ),
  normalizeModelReasoningEffort: jest.fn((value: string) =>
    ['minimal', 'low', 'medium', 'high'].includes(value) ? value : undefined
  ),
  updateCodexConfigProfile: jest.fn(() => ({
    model: 'gpt-5.5',
    configuredReasoningEffort: 'medium',
    effectiveReasoningEffort: 'medium',
  })),
}));

import { ConversationLockManager } from '../utils/conversation-lock';
import * as conversationDb from '../db/conversations';
import * as codexClient from '../clients/codex';
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

  test('shows the current Codex model profile from General', async () => {
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
      '/model',
      { lockManager: new ConversationLockManager(10) }
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('Current Codex model: gpt-5.4');
    expect(result.message).toContain('Current reasoning: high');
    expect(result.message).toContain('/model gpt-5.5 high');
  });

  test('updates Codex model and reasoning from General', async () => {
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
      '/model gpt-5.5 medium',
      { lockManager: new ConversationLockManager(10) }
    );

    expect(codexClient.updateCodexConfigProfile).toHaveBeenCalledWith({
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain('Codex model updated: gpt-5.5');
    expect(result.message).toContain('Reasoning updated: medium');
  });

  test('rejects unsupported Codex model settings from General', async () => {
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
      '/model gpt-4 high',
      { lockManager: new ConversationLockManager(10) }
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Supported models: gpt-5.5, gpt-5.4');
  });
});
