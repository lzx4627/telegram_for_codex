jest.mock('../db/conversations', () => ({
  getOrCreateConversation: jest.fn(),
}));

jest.mock('../db/sessions', () => ({
  getActiveSession: jest.fn(),
  createSession: jest.fn(),
  updateSession: jest.fn(),
  updateSessionMetadata: jest.fn(),
}));

jest.mock('../clients/factory', () => ({
  getAssistantClient: jest.fn(),
}));

import { ConversationLockManager } from '../utils/conversation-lock';
import * as conversationDb from '../db/conversations';
import * as sessionDb from '../db/sessions';
import { getAssistantClient } from '../clients/factory';
import { handleMessage } from './orchestrator';

describe('orchestrator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects ordinary business-topic messages until a path is bound', async () => {
    (conversationDb.getOrCreateConversation as jest.Mock).mockResolvedValue({
      id: 'conv-1',
      platform_type: 'telegram',
      platform_conversation_id: 'telegram:-1001234567890:42',
      platform_chat_id: '-1001234567890',
      platform_thread_id: 42,
      topic_name: 'repo-a',
      codebase_id: null,
      cwd: null,
      ai_assistant_type: 'codex',
    });

    const platform = {
      sendMessage: jest.fn(),
      getStreamingMode: () => 'stream' as const,
      getPlatformType: () => 'telegram',
    };

    await handleMessage(
      platform as never,
      {
        platformType: 'telegram',
        conversationId: 'telegram:-1001234567890:42',
        chatId: '-1001234567890',
        threadId: 42,
        topicName: 'repo-a',
        isGeneral: false,
        isBusinessTopic: true,
      },
      'run the tests',
      { lockManager: new ConversationLockManager(10) }
    );

    expect(platform.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 42 }),
      'No path bound. Run /bind /absolute/path first.'
    );
  });

  test('streams Codex output and records completed status for a bound topic', async () => {
    (conversationDb.getOrCreateConversation as jest.Mock).mockResolvedValue({
      id: 'conv-1',
      platform_type: 'telegram',
      platform_conversation_id: 'telegram:-1001234567890:42',
      platform_chat_id: '-1001234567890',
      platform_thread_id: 42,
      topic_name: 'repo-a',
      codebase_id: null,
      cwd: '/tmp/repo-a',
      ai_assistant_type: 'codex',
    });

    (sessionDb.getActiveSession as jest.Mock).mockResolvedValue({
      id: 'session-1',
      assistant_session_id: null,
      metadata: {},
    });

    (getAssistantClient as jest.Mock).mockReturnValue({
      sendQuery: async function* () {
        yield { type: 'assistant', content: 'running tests now' };
        yield { type: 'result', sessionId: 'codex-thread-1' };
      },
    });

    const platform = {
      sendMessage: jest.fn(),
      getStreamingMode: () => 'stream' as const,
      getPlatformType: () => 'telegram',
    };

    await handleMessage(
      platform as never,
      {
        platformType: 'telegram',
        conversationId: 'telegram:-1001234567890:42',
        chatId: '-1001234567890',
        threadId: 42,
        topicName: 'repo-a',
        isGeneral: false,
        isBusinessTopic: true,
      },
      'run the tests',
      { lockManager: new ConversationLockManager(10) }
    );

    expect(platform.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 42 }),
      '[system] running in /tmp/repo-a'
    );
    expect(sessionDb.updateSession).toHaveBeenCalledWith('session-1', 'codex-thread-1');
    expect(sessionDb.updateSessionMetadata).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ lastOutcome: 'completed' })
    );
    expect(platform.sendMessage).toHaveBeenCalledWith(
      {
        conversationId: 'telegram:-1001234567890:general',
        chatId: '-1001234567890',
        threadId: null,
      },
      expect.stringContaining('[completed] repo-a · /tmp/repo-a ·')
    );
  });

  test('records failed status when Codex throws', async () => {
    (conversationDb.getOrCreateConversation as jest.Mock).mockResolvedValue({
      id: 'conv-1',
      platform_type: 'telegram',
      platform_conversation_id: 'telegram:-1001234567890:42',
      platform_chat_id: '-1001234567890',
      platform_thread_id: 42,
      topic_name: 'repo-a',
      codebase_id: null,
      cwd: '/tmp/repo-a',
      ai_assistant_type: 'codex',
    });

    (sessionDb.getActiveSession as jest.Mock).mockResolvedValue({
      id: 'session-1',
      assistant_session_id: 'codex-thread-1',
      metadata: {},
    });

    (getAssistantClient as jest.Mock).mockReturnValue({
      sendQuery: async function* () {
        throw new Error('codex exploded');
      },
    });

    const platform = {
      sendMessage: jest.fn(),
      getStreamingMode: () => 'stream' as const,
      getPlatformType: () => 'telegram',
    };

    await handleMessage(
      platform as never,
      {
        platformType: 'telegram',
        conversationId: 'telegram:-1001234567890:42',
        chatId: '-1001234567890',
        threadId: 42,
        topicName: 'repo-a',
        isGeneral: false,
        isBusinessTopic: true,
      },
      'run the tests',
      { lockManager: new ConversationLockManager(10) }
    );

    expect(sessionDb.updateSessionMetadata).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ lastOutcome: 'failed', lastError: 'codex exploded' })
    );
    expect(platform.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 42 }),
      '[system] failed: codex exploded'
    );
    expect(platform.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadId: null }),
      expect.stringContaining('[completed]')
    );
  });
});
