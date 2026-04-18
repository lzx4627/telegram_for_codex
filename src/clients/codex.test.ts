/**
 * Unit tests for Codex client helpers
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildCodexOptionsFromEnv,
  buildThreadOptions,
  findLatestGlobalSessionByCwd,
  formatResumeFallbackNotice,
  normalizeModelReasoningEffort,
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

    expect(buildThreadOptions('/tmp/project')).toEqual({
      approvalPolicy: 'never',
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
      timestamp: '2026-04-18T10:21:53.699Z',
    });

    rmSync(root, { recursive: true, force: true });
  });
});
