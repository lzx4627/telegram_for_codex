import type { CommandResult, RuntimeServices, TelegramConversationContext } from '../types';
import * as conversationDb from '../db/conversations';
import {
  getCodexStatusProfile,
  normalizeCodexModel,
  normalizeModelReasoningEffort,
  updateCodexConfigProfile,
} from '../clients/codex';
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
  /model [gpt-5.5|gpt-5.4] [minimal|low|medium|high] - Show or set Codex model
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

    case 'model': {
      if (args.length === 0) {
        const profile = getCodexStatusProfile();
        return {
          success: true,
          message: [
            `Current Codex model: ${profile.model}`,
            `Current reasoning: ${profile.effectiveReasoningEffort}`,
            '',
            'Usage: /model gpt-5.5 high',
            'Supported models: gpt-5.5, gpt-5.4',
            'Supported reasoning: minimal, low, medium, high',
          ].join('\n'),
        };
      }

      let model: ReturnType<typeof normalizeCodexModel>;
      let reasoningEffort: ReturnType<typeof normalizeModelReasoningEffort>;

      for (const arg of args) {
        const parsedModel = normalizeCodexModel(arg);
        const parsedReasoning = normalizeModelReasoningEffort(arg);

        if (parsedModel) {
          model = parsedModel;
          continue;
        }

        if (parsedReasoning) {
          reasoningEffort = parsedReasoning;
          continue;
        }

        return {
          success: false,
          message: [
            `Unsupported model or reasoning value: ${arg}`,
            'Supported models: gpt-5.5, gpt-5.4',
            'Supported reasoning: minimal, low, medium, high',
          ].join('\n'),
        };
      }

      if (!model && !reasoningEffort) {
        return {
          success: false,
          message: 'Usage: /model gpt-5.5 high',
        };
      }

      const profile = updateCodexConfigProfile({
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });

      return {
        success: true,
        message: [
          `Codex model updated: ${profile.model}`,
          `Reasoning updated: ${profile.effectiveReasoningEffort}`,
        ].join('\n'),
      };
    }

    default:
      return {
        success: false,
        message: `Unknown General command: /${command}\n\nUse /help to see General commands.`,
      };
  }
}
