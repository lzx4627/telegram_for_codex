/**
 * Orchestrator - Main conversation handler
 * Routes slash commands and AI messages appropriately
 */
import { readFile } from 'fs/promises';
import { basename, join } from 'path';
import {
  IPlatformAdapter,
  PlatformMessageTarget,
  RuntimeServices,
  TelegramConversationContext,
  Session,
} from '../types';
import {
  buildTelegramConversationId,
  getTelegramMessageTarget,
} from '../adapters/telegram-context';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import * as sessionDb from '../db/sessions';
import * as commandHandler from '../handlers/command-handler';
import { formatToolCall } from '../utils/tool-formatter';
import { substituteVariables } from '../utils/variable-substitution';
import { getAssistantClient } from '../clients/factory';

export async function handleMessage(
  platform: IPlatformAdapter,
  context: TelegramConversationContext,
  message: string,
  runtime: RuntimeServices,
  issueContext?: string
): Promise<void>;
export async function handleMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  issueContext?: string
): Promise<void>;
export async function handleMessage(
  platform: IPlatformAdapter,
  contextOrConversationId: TelegramConversationContext | string,
  message: string,
  runtimeOrIssueContext?: RuntimeServices | string,
  maybeIssueContext?: string
): Promise<void> {
  if (typeof contextOrConversationId === 'string') {
    await handleLegacyMessage(
      platform,
      contextOrConversationId,
      message,
      typeof runtimeOrIssueContext === 'string' ? runtimeOrIssueContext : maybeIssueContext
    );
    return;
  }

  await handleTelegramTopicMessage(
    platform,
    contextOrConversationId,
    message,
    runtimeOrIssueContext as RuntimeServices,
    maybeIssueContext
  );
}

async function handleTelegramTopicMessage(
  platform: IPlatformAdapter,
  context: TelegramConversationContext,
  message: string,
  runtime: RuntimeServices,
  _issueContext?: string
): Promise<void> {
  const target = getTelegramMessageTarget(context);
  let session: Session | null = null;

  try {
    let conversation = await db.getOrCreateConversation({
      platformType: platform.getPlatformType(),
      conversationId: context.conversationId,
      chatId: context.chatId,
      threadId: context.threadId,
      topicName: context.topicName,
    });

    if (message.startsWith('/')) {
      const result = await commandHandler.handleCommand(conversation, message, runtime);
      await platform.sendMessage(target, result.message);

      if (result.modified) {
        conversation = await db.getOrCreateConversation({
          platformType: platform.getPlatformType(),
          conversationId: context.conversationId,
          chatId: context.chatId,
          threadId: context.threadId,
          topicName: context.topicName,
        });
      }

      return;
    }

    if (!conversation.cwd) {
      await platform.sendMessage(target, 'No path bound. Run /bind /absolute/path first.');
      return;
    }

    const aiClient = getAssistantClient();
    session = await sessionDb.getActiveSession(conversation.id);

    if (!session) {
      session = await sessionDb.createSession({
        conversation_id: conversation.id,
        codebase_id: conversation.codebase_id || undefined,
        ai_assistant_type: 'codex',
        cwd_snapshot: conversation.cwd,
      });
    }

    await platform.sendMessage(target, `[system] running in ${conversation.cwd}`);

    for await (const msg of aiClient.sendQuery(
      message,
      conversation.cwd,
      session.assistant_session_id || undefined
    )) {
      if (msg.type === 'assistant' && msg.content) {
        await platform.sendMessage(target, msg.content);
      } else if (msg.type === 'tool' && msg.toolName) {
        await platform.sendMessage(target, formatToolCall(msg.toolName, msg.toolInput));
      } else if (msg.type === 'system' && msg.content) {
        await platform.sendMessage(target, msg.content);
      } else if (msg.type === 'result' && msg.sessionId) {
        await sessionDb.updateSession(session.id, msg.sessionId);
      }
    }

    await sessionDb.updateSessionMetadata(session.id, {
      lastOutcome: 'completed',
      lastError: null,
      lastFinishedAt: new Date().toISOString(),
    });
    await platform.sendMessage(target, '[system] completed');
    await platform.sendMessage(
      buildGeneralNotificationTarget(context),
      formatCompletionNotification(context, conversation)
    );
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Unknown error';

    if (session) {
      await sessionDb.updateSessionMetadata(session.id, {
        lastOutcome: 'failed',
        lastError: messageText,
        lastFinishedAt: new Date().toISOString(),
      });
    }

    await platform.sendMessage(target, `[system] failed: ${messageText}`);
  }
}

function buildGeneralNotificationTarget(
  context: TelegramConversationContext
): PlatformMessageTarget {
  return {
    conversationId: buildTelegramConversationId(context.chatId, null),
    chatId: context.chatId,
    threadId: null,
  };
}

function formatCompletionNotification(
  context: TelegramConversationContext,
  conversation: { topic_name?: string | null; cwd?: string | null }
): string {
  const cwd = conversation.cwd ?? 'unknown-path';
  const label = resolveCompletionLabel(context, conversation);
  const timestamp = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .replace(',', '');

  return `任务完成：${label} · ${cwd} · ${timestamp} Asia/Shanghai`;
}

function resolveCompletionLabel(
  context: TelegramConversationContext,
  conversation: { topic_name?: string | null; cwd?: string | null }
): string {
  if (context.topicName) {
    return context.topicName;
  }

  if (conversation.topic_name) {
    return conversation.topic_name;
  }

  if (conversation.cwd) {
    return basename(conversation.cwd);
  }

  return `thread-${context.threadId}`;
}

async function handleLegacyMessage(
  platform: IPlatformAdapter,
  conversationId: string,
  message: string,
  issueContext?: string
): Promise<void> {
  try {
    console.log(`[Orchestrator] Handling legacy message for conversation ${conversationId}`);

    let conversation = await db.getOrCreateConversation(platform.getPlatformType(), conversationId);

    if (message.startsWith('/')) {
      if (!message.startsWith('/command-invoke')) {
        const result = await commandHandler.handleCommand(conversation, message);
        await platform.sendMessage(conversationId, result.message);

        if (result.modified) {
          conversation = await db.getOrCreateConversation(platform.getPlatformType(), conversationId);
        }
        return;
      }
    }

    let promptToSend = message;
    let commandName: string | null = null;

    if (message.startsWith('/command-invoke')) {
      const { args: parsedArgs } = commandHandler.parseCommand(message);

      if (parsedArgs.length < 1) {
        await platform.sendMessage(conversationId, 'Usage: /command-invoke <name> [args...]');
        return;
      }

      commandName = parsedArgs[0];
      const args = parsedArgs.slice(1);

      if (!conversation.codebase_id) {
        await platform.sendMessage(conversationId, 'No codebase configured. Use /clone first.');
        return;
      }

      const codebase = await codebaseDb.getCodebase(conversation.codebase_id);
      if (!codebase) {
        await platform.sendMessage(conversationId, 'Codebase not found.');
        return;
      }

      const commandDef = codebase.commands[commandName];
      if (!commandDef) {
        await platform.sendMessage(
          conversationId,
          `Command '${commandName}' not found. Use /commands to see available.`
        );
        return;
      }

      const cwd = conversation.cwd || codebase.default_cwd;
      const commandFilePath = join(cwd, commandDef.path);

      try {
        const commandText = await readFile(commandFilePath, 'utf-8');
        promptToSend = substituteVariables(commandText, args);

        if (issueContext) {
          promptToSend = promptToSend + '\n\n---\n\n' + issueContext;
        }
      } catch (error) {
        const err = error as Error;
        await platform.sendMessage(conversationId, `Failed to read command file: ${err.message}`);
        return;
      }
    } else if (!conversation.codebase_id) {
      await platform.sendMessage(conversationId, 'No codebase configured. Use /clone first.');
      return;
    }

    const aiClient = getAssistantClient();
    let session = await sessionDb.getActiveSession(conversation.id);
    const codebase = conversation.codebase_id
      ? await codebaseDb.getCodebase(conversation.codebase_id)
      : null;
    const cwd = conversation.cwd || codebase?.default_cwd || '/workspace';

    if (!session) {
      session = await sessionDb.createSession({
        conversation_id: conversation.id,
        codebase_id: conversation.codebase_id || undefined,
        ai_assistant_type: 'codex',
        cwd_snapshot: cwd,
      });
    }

    const mode = platform.getStreamingMode();

    if (mode === 'stream') {
      for await (const msg of aiClient.sendQuery(
        promptToSend,
        cwd,
        session.assistant_session_id || undefined
      )) {
        if (msg.type === 'assistant' && msg.content) {
          await platform.sendMessage(conversationId, msg.content);
        } else if (msg.type === 'tool' && msg.toolName) {
          await platform.sendMessage(conversationId, formatToolCall(msg.toolName, msg.toolInput));
        } else if (msg.type === 'result' && msg.sessionId) {
          await sessionDb.updateSession(session.id, msg.sessionId);
        }
      }
    } else {
      const assistantMessages: string[] = [];

      for await (const msg of aiClient.sendQuery(
        promptToSend,
        cwd,
        session.assistant_session_id || undefined
      )) {
        if (msg.type === 'assistant' && msg.content) {
          assistantMessages.push(msg.content);
        } else if (msg.type === 'result' && msg.sessionId) {
          await sessionDb.updateSession(session.id, msg.sessionId);
        }
      }

      const finalMessage = assistantMessages[assistantMessages.length - 1];
      if (finalMessage) {
        await platform.sendMessage(conversationId, finalMessage);
      }
    }

    if (commandName) {
      await sessionDb.updateSessionMetadata(session.id, { lastCommand: commandName });
    }
  } catch (error) {
    console.error('[Orchestrator] Error:', error);
    await platform.sendMessage(
      conversationId,
      '⚠️ An error occurred. Try /reset to start a fresh session.'
    );
  }
}
