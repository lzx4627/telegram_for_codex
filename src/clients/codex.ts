/**
 * Codex SDK wrapper
 * Provides async generator interface for streaming Codex responses
 */
import { Dirent, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { IAssistantClient, MessageChunk } from '../types';

// Type definition for Codex SDK (ESM import)
type CodexSDK = typeof import('@openai/codex-sdk');
type Codex = InstanceType<CodexSDK['Codex']>;
type CodexOptions = ConstructorParameters<CodexSDK['Codex']>[0];
type ThreadOptions = Parameters<Codex['startThread']>[0];
type ThreadEvent = import('@openai/codex-sdk').ThreadEvent;
type RunStreamedEvents = AsyncGenerator<ThreadEvent>;

// Singleton Codex instance
let codexInstance: Codex | null = null;
let codexClass: CodexSDK['Codex'] | null = null;

// Dynamic import that bypasses TypeScript transpilation
// This prevents TS from converting import() to require() when module=commonjs
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importDynamic = new Function('modulePath', 'return import(modulePath)');
const SUPPORTED_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);
const SUPPORTED_CODEX_MODELS = new Set(['gpt-5.5', 'gpt-5.4']);
const DEFAULT_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_MAX_DURATION_MS = 60 * 60 * 1000;

type SupportedReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';
type SupportedCodexModel = 'gpt-5.5' | 'gpt-5.4';

export function normalizeModelReasoningEffort(
  value?: string | null
): SupportedReasoningEffort | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'xhigh') {
    return 'high';
  }

  if (SUPPORTED_REASONING_EFFORTS.has(normalized)) {
    return normalized as SupportedReasoningEffort;
  }

  return undefined;
}

export function normalizeCodexModel(value?: string | null): SupportedCodexModel | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (SUPPORTED_CODEX_MODELS.has(normalized)) {
    return normalized as SupportedCodexModel;
  }

  return undefined;
}

export function formatResumeFallbackNotice(sessionId: string): string {
  return `Resume failed for recovered session ${sessionId}. Started a fresh session instead.`;
}

export function formatCodexTimeoutMessage(kind: 'idle' | 'total', timeoutMs: number): string {
  const seconds = Math.floor(timeoutMs / 1000);
  if (kind === 'idle') {
    return `Codex stream timed out after ${seconds}s without events.`;
  }

  return `Codex stream exceeded the ${seconds}s maximum duration.`;
}

export function getCodexTimeoutConfig(): {
  idleTimeoutMs: number;
  maxDurationMs: number;
} {
  const idleTimeoutMs = Number(process.env.CODEX_STREAM_IDLE_TIMEOUT_MS || DEFAULT_IDLE_TIMEOUT_MS);
  const maxDurationMs = Number(process.env.CODEX_STREAM_MAX_DURATION_MS || DEFAULT_MAX_DURATION_MS);

  return {
    idleTimeoutMs: Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0 ? idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS,
    maxDurationMs:
      Number.isFinite(maxDurationMs) && maxDurationMs > 0 ? maxDurationMs : DEFAULT_MAX_DURATION_MS,
  };
}

async function nextThreadEventWithTimeout(
  events: RunStreamedEvents,
  timeoutMs: number
): Promise<IteratorResult<ThreadEvent>> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      events.next() as Promise<IteratorResult<ThreadEvent>>,
      new Promise<IteratorResult<ThreadEvent>>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Codex stream timeout'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function findLatestGlobalSessionByCwd(
  cwd: string,
  sessionsRoot = join(homedir(), '.codex', 'sessions')
): { sessionId: string; timestamp: string } | null {
  const stack = [sessionsRoot];
  let latestTopLevel: { sessionId: string; timestamp: string } | null = null;
  let latestAny: { sessionId: string; timestamp: string } | null = null;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const nextPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      let content: string;
      try {
        content = readFileSync(nextPath, 'utf8');
      } catch {
        continue;
      }

      const lines = content.split('\n').filter(Boolean);
      const sessionMetaLine = lines.find(line => line.includes('"type":"session_meta"'));
      if (!sessionMetaLine) {
        continue;
      }

      try {
        const lastLine = lines[lines.length - 1];
        const lastEvent = lastLine ? JSON.parse(lastLine) as { timestamp?: string } : undefined;
        const parsed = JSON.parse(sessionMetaLine) as {
          payload?: {
            id?: string;
            timestamp?: string;
            cwd?: string;
            source?: {
              subagent?: {
                thread_spawn?: {
                  parent_thread_id?: string;
                };
              };
            };
          };
        };
        if (
          parsed.payload?.cwd === cwd &&
          parsed.payload.id &&
          parsed.payload.timestamp
        ) {
          const candidate = {
            sessionId: parsed.payload.id,
            timestamp: lastEvent?.timestamp ?? parsed.payload.timestamp,
          };

          if (!latestAny || candidate.timestamp > latestAny.timestamp) {
            latestAny = candidate;
          }

          const isSubagentSession = Boolean(
            parsed.payload.source?.subagent?.thread_spawn?.parent_thread_id
          );
          if (!isSubagentSession && (!latestTopLevel || candidate.timestamp > latestTopLevel.timestamp)) {
            latestTopLevel = candidate;
          }
        }
      } catch {
        continue;
      }
    }
  }

  return latestTopLevel ?? latestAny;
}

function getCodexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

function readCodexConfigToml(configPath = getCodexConfigPath()): string | undefined {
  try {
    return readFileSync(configPath, 'utf8');
  } catch {
    return undefined;
  }
}

function getNonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
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
  effectiveReasoningEffort: SupportedReasoningEffort;
} {
  const configText = readCodexConfigToml();
  const model =
    getNonEmptyEnv('CODEX_MODEL') ?? getNonEmptyEnv('OPENAI_MODEL') ?? extractConfigModel(configText) ?? 'unknown';
  const configuredReasoningEffort =
    getNonEmptyEnv('CODEX_MODEL_REASONING_EFFORT') ?? extractConfigReasoningEffort(configText) ?? 'medium';
  const effectiveReasoningEffort = normalizeModelReasoningEffort(configuredReasoningEffort) ?? 'medium';

  return {
    model,
    configuredReasoningEffort,
    effectiveReasoningEffort,
  };
}

function upsertTomlStringValue(configText: string, key: string, value: string): string {
  const line = `${key} = "${value}"`;
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*"[^"]*"\\s*$`, 'm');

  if (pattern.test(configText)) {
    return configText.replace(pattern, line);
  }

  const prefix = configText.trimEnd();
  return `${prefix ? `${prefix}\n` : ''}${line}\n`;
}

export function updateCodexConfigProfile(
  update: { model?: SupportedCodexModel; reasoningEffort?: SupportedReasoningEffort },
  configPath = getCodexConfigPath()
): {
  model: string;
  configuredReasoningEffort: string;
  effectiveReasoningEffort: SupportedReasoningEffort;
} {
  let configText = readCodexConfigToml(configPath) ?? '';

  if (update.model) {
    configText = upsertTomlStringValue(configText, 'model', update.model);
  }

  if (update.reasoningEffort) {
    configText = upsertTomlStringValue(configText, 'model_reasoning_effort', update.reasoningEffort);
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, configText, 'utf8');

  const model = update.model ?? extractConfigModel(configText) ?? 'unknown';
  const configuredReasoningEffort =
    update.reasoningEffort ?? extractConfigReasoningEffort(configText) ?? 'medium';

  return {
    model,
    configuredReasoningEffort,
    effectiveReasoningEffort: normalizeModelReasoningEffort(configuredReasoningEffort) ?? 'medium',
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
  const profile = getCodexStatusProfile();
  const modelReasoningEffort = profile.effectiveReasoningEffort;
  const model = normalizeCodexModel(profile.model);

  return {
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    ...(model ? { model } : {}),
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
    const timeoutConfig = getCodexTimeoutConfig();
    const startedAt = Date.now();
    let lastEventAt = startedAt;

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
      const events = result.events as RunStreamedEvents;

      // Process streaming events
      while (true) {
        const now = Date.now();
        const idleRemaining = timeoutConfig.idleTimeoutMs - (now - lastEventAt);
        const totalRemaining = timeoutConfig.maxDurationMs - (now - startedAt);

        if (idleRemaining <= 0) {
          const message = formatCodexTimeoutMessage('idle', timeoutConfig.idleTimeoutMs);
          yield { type: 'system', content: `⚠️ ${message}` };
          throw new Error(message);
        }

        if (totalRemaining <= 0) {
          const message = formatCodexTimeoutMessage('total', timeoutConfig.maxDurationMs);
          yield { type: 'system', content: `⚠️ ${message}` };
          throw new Error(message);
        }

        let nextResult: IteratorResult<ThreadEvent>;
        try {
          nextResult = await nextThreadEventWithTimeout(
            events,
            Math.min(idleRemaining, totalRemaining)
          );
        } catch (error) {
          if ((error as Error).message !== 'Codex stream timeout') {
            throw error;
          }

          await events.return?.(undefined);
          const current = Date.now();
          const idleExceeded = current - lastEventAt >= timeoutConfig.idleTimeoutMs;
          const totalExceeded = current - startedAt >= timeoutConfig.maxDurationMs;
          const message = idleExceeded
            ? formatCodexTimeoutMessage('idle', timeoutConfig.idleTimeoutMs)
            : formatCodexTimeoutMessage('total', timeoutConfig.maxDurationMs);

          yield { type: 'system', content: `⚠️ ${message}` };
          throw idleExceeded || totalExceeded ? new Error(message) : error;
        }

        if (nextResult.done) {
          break;
        }

        lastEventAt = Date.now();
        const event = nextResult.value;

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
