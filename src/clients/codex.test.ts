/**
 * Unit tests for Codex client helpers
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildCodexOptionsFromEnv,
  formatCodexTimeoutMessage,
  buildThreadOptions,
  findLatestGlobalSessionByCwd,
  formatResumeFallbackNotice,
  getCodexTimeoutConfig,
  normalizeModelReasoningEffort,
  updateCodexConfigProfile,
} from './codex';

describe('CodexClient', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('normalizes xhigh reasoning effort to high', () => {
    expect(normalizeModelReasoningEffort('xhigh')).toBe('high');
  });

  test('preserves supported reasoning effort values', () => {
    expect(normalizeModelReasoningEffort('minimal')).toBe('minimal');
    expect(normalizeModelReasoningEffort('low')).toBe('low');
    expect(normalizeModelReasoningEffort('medium')).toBe('medium');
    expect(normalizeModelReasoningEffort('high')).toBe('high');
  });

  test('builds codex options from explicit codex base url and codex api key env vars', () => {
    process.env.CODEX_BASE_URL = 'http://127.0.0.1:8080/v1';
    process.env.CODEX_API_KEY = 'test-key';

    expect(buildCodexOptionsFromEnv()).toEqual({
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: 'test-key',
    });
  });

  test('does not remap OPENAI_API_KEY into SDK apiKey options', () => {
    process.env.OPENAI_API_KEY = 'openai-style-key';

    expect(buildCodexOptionsFromEnv()).toBeUndefined();
  });

  test('builds thread options with normalized reasoning effort', () => {
    process.env.CODEX_MODEL_REASONING_EFFORT = 'xhigh';
    process.env.CODEX_MODEL = 'gpt-5.5';

    expect(buildThreadOptions('/tmp/project')).toEqual({
      approvalPolicy: 'never',
      model: 'gpt-5.5',
      modelReasoningEffort: 'high',
      sandboxMode: 'danger-full-access',
      skipGitRepoCheck: true,
      workingDirectory: '/tmp/project',
    });
  });

  test('formats a user-facing resume fallback notice', () => {
    expect(formatResumeFallbackNotice('codex-thread-9')).toBe(
      'Resume failed for recovered session codex-thread-9. Started a fresh session instead.'
    );
  });

  test('uses sane default stream timeout settings', () => {
    delete process.env.CODEX_STREAM_IDLE_TIMEOUT_MS;
    delete process.env.CODEX_STREAM_MAX_DURATION_MS;

    expect(getCodexTimeoutConfig()).toEqual({
      idleTimeoutMs: 180000,
      maxDurationMs: 3600000,
    });
  });

  test('allows stream timeout settings to be overridden from env', () => {
    process.env.CODEX_STREAM_IDLE_TIMEOUT_MS = '90000';
    process.env.CODEX_STREAM_MAX_DURATION_MS = '1200000';

    expect(getCodexTimeoutConfig()).toEqual({
      idleTimeoutMs: 90000,
      maxDurationMs: 1200000,
    });
  });

  test('formats timeout messages for idle and total duration guards', () => {
    expect(formatCodexTimeoutMessage('idle', 180000)).toBe(
      'Codex stream timed out after 180s without events.'
    );
    expect(formatCodexTimeoutMessage('total', 3600000)).toBe(
      'Codex stream exceeded the 3600s maximum duration.'
    );
  });

  test('updates model and reasoning in a Codex config toml file', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-config-'));
    const configPath = join(root, 'config.toml');
    writeFileSync(configPath, 'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\n', 'utf8');

    const profile = updateCodexConfigProfile(
      {
        model: 'gpt-5.5',
        reasoningEffort: 'medium',
      },
      configPath
    );

    expect(profile).toEqual({
      model: 'gpt-5.5',
      configuredReasoningEffort: 'medium',
      effectiveReasoningEffort: 'medium',
    });

    rmSync(root, { recursive: true, force: true });
  });

  test('finds the latest global codex session by cwd from ~/.codex/sessions layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
    const olderDir = join(root, '2026', '04', '16');
    const newerDir = join(root, '2026', '04', '18');
    mkdirSync(olderDir, { recursive: true });
    mkdirSync(newerDir, { recursive: true });

    writeFileSync(
      join(olderDir, 'old.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-04-16T14:21:53.719Z',
        type: 'session_meta',
        payload: {
          id: 'session-old',
          timestamp: '2026-04-16T14:21:53.699Z',
          cwd: '/opt/github_trend_report',
        },
      })}\n`,
      'utf8'
    );

    writeFileSync(
      join(newerDir, 'new.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-04-18T10:21:53.719Z',
        type: 'session_meta',
        payload: {
          id: 'session-new',
          timestamp: '2026-04-18T10:21:53.699Z',
          cwd: '/opt/github_trend_report',
        },
      })}\n`,
      'utf8'
    );

    expect(findLatestGlobalSessionByCwd('/opt/github_trend_report', root)).toEqual({
      sessionId: 'session-new',
      timestamp: '2026-04-18T10:21:53.719Z',
    });

    rmSync(root, { recursive: true, force: true });
  });

  test('prefers a top-level session over a newer subagent session for the same cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
    const sessionDir = join(root, '2026', '04', '18');
    mkdirSync(sessionDir, { recursive: true });

    writeFileSync(
      join(sessionDir, 'root.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-04-18T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'root-session',
          timestamp: '2026-04-18T10:00:00.000Z',
          cwd: '/opt/github_trend_report',
          source: {},
        },
      })}\n`,
      'utf8'
    );

    writeFileSync(
      join(sessionDir, 'child.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-04-18T11:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'child-session',
          timestamp: '2026-04-18T11:00:00.000Z',
          cwd: '/opt/github_trend_report',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'root-session',
              },
            },
          },
        },
      })}\n`,
      'utf8'
    );

    expect(findLatestGlobalSessionByCwd('/opt/github_trend_report', root)).toEqual({
      sessionId: 'root-session',
      timestamp: '2026-04-18T10:00:00.000Z',
    });

    rmSync(root, { recursive: true, force: true });
  });

  test('prefers the top-level session with the most recent activity, not the newest creation time', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
    const sessionDir = join(root, '2026', '04', '20');
    mkdirSync(sessionDir, { recursive: true });

    writeFileSync(
      join(sessionDir, 'older-but-active.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-04-10T02:18:00.322Z',
          type: 'session_meta',
          payload: {
            id: 'root-active',
            timestamp: '2026-04-10T02:18:00.322Z',
            cwd: '/opt/notebook',
            source: 'cli',
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-18T12:58:02.985Z',
          type: 'task_complete',
          payload: {},
        }),
      ].join('\n'),
      'utf8'
    );

    writeFileSync(
      join(sessionDir, 'newer-but-stale.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-04-15T09:55:46.746Z',
          type: 'session_meta',
          payload: {
            id: 'root-stale',
            timestamp: '2026-04-15T09:55:46.746Z',
            cwd: '/opt/notebook',
            source: 'cli',
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-15T09:59:59.792Z',
          type: 'task_complete',
          payload: {},
        }),
      ].join('\n'),
      'utf8'
    );

    expect(findLatestGlobalSessionByCwd('/opt/notebook', root)).toEqual({
      sessionId: 'root-active',
      timestamp: '2026-04-18T12:58:02.985Z',
    });

    rmSync(root, { recursive: true, force: true });
  });
});
