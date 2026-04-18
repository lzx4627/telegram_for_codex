jest.mock('./connection', () => ({
  pool: {
    query: jest.fn(),
  },
}));

import { pool } from './connection';
import { createSession, getLatestRestorableSessionByCwd } from './sessions';

describe('sessions db', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('creates sessions with cwd snapshot and metadata', async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({
      rows: [
        {
          id: 'session-1',
          conversation_id: 'conv-1',
          assistant_session_id: 'codex-thread-1',
          cwd_snapshot: '/tmp/repo-a',
          metadata: { resumeSource: 'cwd-history' },
        },
      ],
    });

    const session = await createSession({
      conversation_id: 'conv-1',
      ai_assistant_type: 'codex',
      assistant_session_id: 'codex-thread-1',
      cwd_snapshot: '/tmp/repo-a',
      metadata: { resumeSource: 'cwd-history' },
    });

    expect(session.cwd_snapshot).toBe('/tmp/repo-a');
    expect((pool.query as jest.Mock).mock.calls[0][1]).toEqual([
      'conv-1',
      null,
      'codex',
      'codex-thread-1',
      '/tmp/repo-a',
      JSON.stringify({ resumeSource: 'cwd-history' }),
    ]);
  });

  test('finds the latest restorable codex session by cwd across the machine', async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({
      rows: [
        {
          id: 'session-9',
          conversation_id: 'conv-9',
          assistant_session_id: 'codex-thread-9',
          ai_assistant_type: 'codex',
          cwd_snapshot: '/tmp/repo-a',
          metadata: {},
        },
      ],
    });

    const session = await getLatestRestorableSessionByCwd('/tmp/repo-a');

    expect(session?.assistant_session_id).toBe('codex-thread-9');
    expect((pool.query as jest.Mock).mock.calls[0][1]).toEqual(['/tmp/repo-a', 'codex']);
  });
});
