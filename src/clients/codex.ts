/**
 * Codex SDK wrapper
 * Provides async generator interface for streaming Codex responses
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { IAssistantClient, MessageChunk } from '../types';

// Type definition for Codex SDK (ESM import)
type CodexSDK = typeof import('@openai/codex-sdk');
type Codex = InstanceType<CodexSDK['Codex']>;
type CodexOptions = ConstructorParameters<CodexSDK['Codex']>[0];
type ThreadOptions = Parameters<Codex['startThread']>[0];

// Singleton Codex instance
let codexInstance: Codex | null = null;
let codexClass: CodexSDK['Codex'] | null = null;

// Dynamic import that bypasses TypeScript transpilation
// This prevents TS from converting import() to require() when module=commonjs
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importDynamic = new Function('modulePath', 'return import(modulePath)');
const SUPPORTED_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

export function normalizeModelReasoningEffort(
  value?: string | null
): 'minimal' | 'low' | 'medium' | 'high' | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'xhigh') {
    return 'high';
  }

  if (SUPPORTED_REASONING_EFFORTS.has(normalized)) {
    return normalized as 'minimal' | 'low' | 'medium' | 'high';
  }

  return undefined;
}

export function formatResumeFallbackNotice(sessionId: string): string {
  return `Resume failed for recovered session ${sessionId}. Started a fresh session instead.`;
}

function readCodexConfigToml(): string | undefined {
  try {
    return readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8');
  } catch {
    return undefined;
  }
}

function extractConfigReasoningEffort(configText?: string): string | undefined {
  if (!configText) {
    return undefined;
  }

  const match = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(configText);
  return match?.[1];
}

function extractConfigModel(configText?: string): string | undefined {
  if (!configText) {
    return undefined;
  }

  const match = /^\s*model\s*=\s*"([^"]+)"/m.exec(configText);
  return match?.[1];
}

export function getCodexStatusProfile(): {
  model: string;
  configuredReasoningEffort: string;
  effectiveReasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
} {
  const configText = readCodexConfigToml();
  const model =
    process.env.CODEX_MODEL ?? process.env.OPENAI_MODEL ?? extractConfigModel(configText) ?? 'unknown';
  const configuredReasoningEffort =
    process.env.CODEX_MODEL_REASONING_EFFORT ?? extractConfigReasoningEffort(configText) ?? 'medium';
  const effectiveReasoningEffort = normalizeModelReasoningEffort(configuredReasoningEffort) ?? 'medium';

  return {
    model,
    configuredReasoningEffort,
    effectiveReasoningEffort,
  };
}

export function buildCodexOptionsFromEnv(): CodexOptions | undefined {
  const baseUrl = process.env.CODEX_BASE_URL ?? process.env.OPENAI_BASE_URL;
  const apiKey = process.env.CODEX_API_KEY;

  if (!baseUrl && !apiKey) {
    return undefined;
  }

  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

export function buildThreadOptions(cwd: string): ThreadOptions {
  const modelReasoningEffort = getCodexStatusProfile().effectiveReasoningEffort;

  return {
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
  };
}

/**
 * Get or create Codex SDK instance (uses dynamic import for ESM compatibility)
 */
async function getCodex(): Promise<Codex> {
  if (!codexInstance) {
    if (!codexClass) {
      // Dynamic import to handle ESM-only package (bypasses TS transpilation)
      // eslint-disable-next-line @typescript-eslint/naming-convention, @typescript-eslint/no-unsafe-call
      const { Codex: ImportedCodex } = await importDynamic('@openai/codex-sdk') as CodexSDK;
      codexClass = ImportedCodex;
    }

    const options = buildCodexOptionsFromEnv();
    codexInstance = options ? new codexClass(options) : new codexClass();
  }
  return codexInstance;
}

/**
 * Codex AI assistant client
 * Implements generic IAssistantClient interface
 */
export class CodexClient implements IAssistantClient {
  /**
   * Send a query to Codex and stream responses
   * @param prompt - User message or prompt
   * @param cwd - Working directory for Codex
   * @param resumeSessionId - Optional thread ID to resume
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string
  ): AsyncGenerator<MessageChunk> {
    const codex = await getCodex();
    let resumeFallbackNotice: string | null = null;

    // Get or create thread (synchronous operations!)
    let thread;
    if (resumeSessionId) {
      console.log(`[Codex] Resuming thread: ${resumeSessionId}`);
      try {
        // NOTE: resumeThread is synchronous, not async
        // IMPORTANT: Must pass options when resuming!
        thread = codex.resumeThread(resumeSessionId, buildThreadOptions(cwd));
      } catch (error) {
        console.error(`[Codex] Failed to resume thread ${resumeSessionId}, creating new one:`, error);
        resumeFallbackNotice = formatResumeFallbackNotice(resumeSessionId);
        // Fall back to creating new thread
        thread = codex.startThread(buildThreadOptions(cwd));
      }
    } else {
      console.log(`[Codex] Starting new thread in ${cwd}`);
      // NOTE: startThread is synchronous, not async
      thread = codex.startThread(buildThreadOptions(cwd));
    }

    try {
      if (resumeFallbackNotice) {
        yield { type: 'system', content: resumeFallbackNotice };
      }

      // Run streamed query (this IS async)
      const result = await thread.runStreamed(prompt);

      // Process streaming events
      for await (const event of result.events) {
        // Handle error events
        if (event.type === 'error') {
          console.error('[Codex] Stream error:', event.message);
          // Don't send MCP timeout errors (they're optional)
          if (!event.message.includes('MCP client')) {
            yield { type: 'system', content: `⚠️ ${event.message}` };
          }
          continue;
        }

        // Handle turn failed events
        if (event.type === 'turn.failed') {
          console.error('[Codex] Turn failed:', event.error?.message);
          yield {
            type: 'system',
            content: `❌ Turn failed: ${event.error?.message || 'Unknown error'}`,
          };
          break;
        }

        // Handle item.completed events - map to MessageChunk types
        if (event.type === 'item.completed') {
          const item = event.item;

          switch (item.type) {
            case 'agent_message':
              // Agent text response
              if (item.text) {
                yield { type: 'assistant', content: item.text };
              }
              break;

            case 'command_execution':
              // Tool/command execution
              if (item.command) {
                yield { type: 'tool', toolName: item.command };
              }
              break;

            case 'reasoning':
              // Agent reasoning/thinking
              if (item.text) {
                yield { type: 'thinking', content: item.text };
              }
              break;

            // Other item types are ignored (like file edits, etc.)
          }
        }

        // Handle turn.completed event
        if (event.type === 'turn.completed') {
          console.log('[Codex] Turn completed');
          // Yield result with thread ID for persistence
          yield { type: 'result', sessionId: thread.id || undefined };
          // CRITICAL: Break out of event loop - turn is complete!
          // Without this, the loop waits for stream to end (causes 90s timeout)
          break;
        }
      }
    } catch (error) {
      console.error('[Codex] Query error:', error);
      throw new Error(`Codex query failed: ${(error as Error).message}`);
    }
  }

  /**
   * Get the assistant type identifier
   */
  getType(): string {
    return 'codex';
  }
}
