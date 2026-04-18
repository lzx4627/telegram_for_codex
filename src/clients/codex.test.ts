/**
 * Unit tests for Codex client helpers
 */
import {
  buildCodexOptionsFromEnv,
  buildThreadOptions,
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
      modelReasoningEffort: 'high',
      skipGitRepoCheck: true,
      workingDirectory: '/tmp/project',
    });
  });
});
