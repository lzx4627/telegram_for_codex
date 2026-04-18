import type { Context } from 'telegraf';
import type { PlatformMessageTarget, TelegramConversationContext } from '../types';

export function buildTelegramConversationId(
  chatId: string | number,
  threadId: number | null
): string {
  return threadId == null ? `telegram:${chatId}:general` : `telegram:${chatId}:${threadId}`;
}

export function getTelegramConversationContext(ctx: Context): TelegramConversationContext {
  if (!ctx.chat || !ctx.message || !('text' in ctx.message)) {
    throw new Error('Telegram context is missing chat or message text');
  }

  const chatId = ctx.chat.id.toString();
  const rawThreadId = 'message_thread_id' in ctx.message ? ctx.message.message_thread_id : undefined;
  const threadId = typeof rawThreadId === 'number' ? rawThreadId : null;
  const topicCreated =
    'forum_topic_created' in ctx.message
      ? (ctx.message.forum_topic_created as { name?: string } | undefined)
      : undefined;
  const topicName = topicCreated?.name ?? null;

  return {
    platformType: 'telegram',
    conversationId: buildTelegramConversationId(chatId, threadId),
    chatId,
    threadId,
    topicName,
    isGeneral: threadId == null,
    isBusinessTopic: threadId != null,
  };
}

export function getTelegramMessageTarget(
  context: TelegramConversationContext
): PlatformMessageTarget {
  return {
    conversationId: context.conversationId,
    chatId: context.chatId,
    threadId: context.threadId,
  };
}
