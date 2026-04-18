import type { CommandResult, RuntimeServices, TelegramConversationContext } from '../types';
import * as conversationDb from '../db/conversations';
import { parseCommand } from './command-handler';

export async function handleGeneralTopicCommand(
  telegram: { createTopic(chatId: string, topicName: string): Promise<{ threadId: number; name: string }> },
  context: TelegramConversationContext,
  message: string,
  runtime: RuntimeServices
): Promise<CommandResult> {
  const { command, args } = parseCommand(message);

  switch (command) {
    case 'help':
      return {
        success: true,
        message: `General Commands:

  /topic <name> - Create a new business topic
  /topics - List current business topics and bound paths
  /help - Show this help`,
      };

    case 'topic': {
      if (args.length === 0) {
        return { success: false, message: 'Usage: /topic <name>' };
      }

      const topicName = args.join(' ');
      const created = await telegram.createTopic(context.chatId, topicName);

      return {
        success: true,
        message: `Created topic '${created.name}' (thread ${created.threadId}).\nOpen that topic and run /bind /absolute/path.`,
      };
    }

    case 'topics': {
      const conversations = await conversationDb.listConversationsByChatId('telegram', context.chatId);

      if (conversations.length === 0) {
        return {
          success: true,
          message: 'No business topics have been bound yet.',
        };
      }

      const lines = conversations.map(conversation => {
        const runtimeState = runtime.lockManager.getConversationState(
          conversation.platform_conversation_id
        );

        return [
          `${conversation.topic_name ?? conversation.platform_thread_id} (#${conversation.platform_thread_id})`,
          `  path: ${conversation.cwd ?? 'Not set'}`,
          `  state: ${runtimeState.state}`,
          `  queue: ${runtimeState.queueLength}`,
        ].join('\n');
      });

      return {
        success: true,
        message: ['Business Topics:', ...lines].join('\n\n'),
      };
    }

    default:
      return {
        success: false,
        message: `Unknown General command: /${command}\n\nUse /help to see General commands.`,
      };
  }
}
