/**
 * Unit tests for Telegram adapter
 */
import { TelegramAdapter } from './telegram';
import { buildTelegramConversationId } from './telegram-context';

describe('TelegramAdapter', () => {
  describe('streaming mode configuration', () => {
    test('should return batch mode when configured', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing', 'batch');
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('should default to stream mode', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      expect(adapter.getStreamingMode()).toBe('stream');
    });

    test('should return stream mode when explicitly configured', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing', 'stream');
      expect(adapter.getStreamingMode()).toBe('stream');
    });
  });

  describe('bot instance', () => {
    test('should provide access to bot instance', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const bot = adapter.getBot();
      expect(bot).toBeDefined();
      expect(bot.telegram).toBeDefined();
    });
  });

  describe('topic-aware messaging', () => {
    test('sends replies back to the originating topic', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const sendMessageMock = jest
        .spyOn(adapter.getBot().telegram, 'sendMessage')
        .mockResolvedValue({} as never);

      await adapter.sendMessage(
        {
          conversationId: buildTelegramConversationId('-1001234567890', 42),
          chatId: '-1001234567890',
          threadId: 42,
        },
        'hello from codex'
      );

      expect(sendMessageMock).toHaveBeenCalledWith(-1001234567890, 'hello from codex', {
        message_thread_id: 42,
      });
    });

    test('creates a forum topic in the current Telegram group', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const createForumTopicMock = jest
        .spyOn(adapter.getBot().telegram, 'createForumTopic')
        .mockResolvedValue({ message_thread_id: 77, name: 'repo-a' } as never);

      await expect(adapter.createTopic('-1001234567890', 'repo-a')).resolves.toEqual({
        threadId: 77,
        name: 'repo-a',
      });

      expect(createForumTopicMock).toHaveBeenCalledWith(-1001234567890, 'repo-a');
    });
  });

  describe('command registration', () => {
    test('registers slash commands when the bot starts', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const launchMock = jest.spyOn(adapter.getBot(), 'launch').mockResolvedValue(undefined as never);
      const setMyCommandsMock = jest
        .spyOn(adapter.getBot().telegram, 'setMyCommands')
        .mockResolvedValue(true as never);

      await adapter.start();

      expect(launchMock).toHaveBeenCalledWith({
        dropPendingUpdates: true,
      });
      expect(setMyCommandsMock).toHaveBeenCalledWith([
        { command: 'help', description: 'Show available commands' },
        { command: 'topic', description: 'Create a new business topic from General' },
        { command: 'topics', description: 'List business topics and bound paths' },
        { command: 'bind', description: 'Bind the current topic to an absolute path' },
        { command: 'pwd', description: 'Show the current bound path' },
        { command: 'status', description: 'Show queue and session state' },
        { command: 'reset', description: 'Reset the active Codex session' },
      ]);
    });
  });
});
