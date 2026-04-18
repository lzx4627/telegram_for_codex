import type { Context } from 'telegraf';
import {
  buildTelegramConversationId,
  getTelegramConversationContext,
  getTelegramMessageTarget,
} from './telegram-context';

describe('telegram-context', () => {
  test('treats mainline group commands as General control-plane input', () => {
    const ctx = {
      chat: { id: -1001234567890 },
      message: { text: '/topics' },
    } as unknown as Context;

    expect(getTelegramConversationContext(ctx)).toMatchObject({
      conversationId: 'telegram:-1001234567890:general',
      chatId: '-1001234567890',
      threadId: null,
      isGeneral: true,
      isBusinessTopic: false,
    });
  });

  test('treats threaded messages as business-topic traffic', () => {
    const ctx = {
      chat: { id: -1001234567890 },
      message: {
        text: 'run the tests',
        is_topic_message: true,
        message_thread_id: 42,
      },
    } as unknown as Context;

    expect(getTelegramConversationContext(ctx)).toMatchObject({
      conversationId: 'telegram:-1001234567890:42',
      chatId: '-1001234567890',
      threadId: 42,
      isGeneral: false,
      isBusinessTopic: true,
    });
  });

  test('builds Telegram targets for topic replies', () => {
    const target = getTelegramMessageTarget({
      platformType: 'telegram',
      conversationId: buildTelegramConversationId('-1001234567890', 42),
      chatId: '-1001234567890',
      threadId: 42,
      topicName: 'Repo A',
      isGeneral: false,
      isBusinessTopic: true,
    });

    expect(target).toEqual({
      conversationId: 'telegram:-1001234567890:42',
      chatId: '-1001234567890',
      threadId: 42,
    });
  });
});
