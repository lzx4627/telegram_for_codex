/**
 * Unit tests for command handler
 */
jest.mock('fs/promises', () => ({
  mkdir: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  readdir: jest.fn(),
  access: jest.fn(),
}));

jest.mock('../db/conversations', () => ({
  updateConversation: jest.fn(),
}));

jest.mock('../db/sessions', () => ({
  getActiveSession: jest.fn(),
  getLatestSession: jest.fn(),
  deactivateSession: jest.fn(),
}));

jest.mock('../db/codebases', () => ({
  getCodebase: jest.fn(),
  createCodebase: jest.fn(),
  getCodebaseCommands: jest.fn(),
  registerCommand: jest.fn(),
  updateCodebaseCommands: jest.fn(),
}));

import { mkdir } from 'fs/promises';
import { ConversationLockManager } from '../utils/conversation-lock';
import * as conversationDb from '../db/conversations';
import * as sessionDb from '../db/sessions';
import type { Conversation } from '../types';
import { handleCommand, parseCommand } from './command-handler';

describe('CommandHandler', () => {
  const baseConversation: Conversation = {
    id: 'conv-1',
    platform_type: 'telegram',
    platform_conversation_id: 'telegram:-1001234567890:42',
    platform_chat_id: '-1001234567890',
    platform_thread_id: 42,
    topic_name: 'repo-a',
    codebase_id: null,
    cwd: '/tmp/repo-a',
    ai_assistant_type: 'codex',
    created_at: new Date(),
    updated_at: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parseCommand', () => {
    test('should extract command and args from /clone command', () => {
      const result = parseCommand('/clone https://github.com/user/repo');
      expect(result.command).toBe('clone');
      expect(result.args).toEqual(['https://github.com/user/repo']);
    });

    test('should handle commands without args', () => {
      const result = parseCommand('/help');
      expect(result.command).toBe('help');
      expect(result.args).toEqual([]);
    });

    test('should handle /status command', () => {
      const result = parseCommand('/status');
      expect(result.command).toBe('status');
      expect(result.args).toEqual([]);
    });

    test('should handle /setcwd with path containing spaces', () => {
      const result = parseCommand('/setcwd /workspace/my repo');
      expect(result.command).toBe('setcwd');
      expect(result.args).toEqual(['/workspace/my', 'repo']);
    });

    test('should handle /reset command', () => {
      const result = parseCommand('/reset');
      expect(result.command).toBe('reset');
      expect(result.args).toEqual([]);
    });

    test('should handle command with multiple spaces', () => {
      const result = parseCommand('/clone   https://github.com/user/repo  ');
      expect(result.command).toBe('clone');
      expect(result.args).toEqual(['https://github.com/user/repo']);
    });

    test('should handle /getcwd command', () => {
      const result = parseCommand('/getcwd');
      expect(result.command).toBe('getcwd');
      expect(result.args).toEqual([]);
    });

    test('should parse quoted arguments', () => {
      const result = parseCommand('/command-invoke plan "Add dark mode"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Add dark mode']);
    });

    test('should parse mixed quoted and unquoted args', () => {
      const result = parseCommand('/command-set test .test.md "Task: $1"');
      expect(result.command).toBe('command-set');
      expect(result.args).toEqual(['test', '.test.md', 'Task: $1']);
    });

    test('should parse /command-set', () => {
      const result = parseCommand('/command-set prime .claude/prime.md');
      expect(result.command).toBe('command-set');
      expect(result.args).toEqual(['prime', '.claude/prime.md']);
    });

    test('should parse /load-commands', () => {
      const result = parseCommand('/load-commands .claude/commands');
      expect(result.command).toBe('load-commands');
      expect(result.args).toEqual(['.claude/commands']);
    });

    test('should handle single quotes', () => {
      const result = parseCommand("/command-invoke plan 'Add dark mode'");
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Add dark mode']);
    });

    test('should parse /repos', () => {
      const result = parseCommand('/repos');
      expect(result.command).toBe('repos');
      expect(result.args).toEqual([]);
    });

    // Bug fix tests: Multi-word quoted arguments should be preserved as single arg
    test('should preserve multi-word quoted string as single argument', () => {
      const result = parseCommand('/command-invoke plan "here is the request"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'here is the request']);
      // Specifically verify the second arg is the FULL quoted string
      expect(result.args[1]).toBe('here is the request');
    });

    test('should handle long quoted sentences', () => {
      const result = parseCommand(
        '/command-invoke execute "Implement the user authentication feature with JWT tokens"'
      );
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual([
        'execute',
        'Implement the user authentication feature with JWT tokens',
      ]);
    });

    test('should handle multiple quoted arguments', () => {
      const result = parseCommand('/command-invoke test "first arg" "second arg" "third arg"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['test', 'first arg', 'second arg', 'third arg']);
    });

    test('should handle mixed quoted and unquoted with spaces', () => {
      const result = parseCommand('/command-invoke plan "Add feature X" --flag value');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Add feature X', '--flag', 'value']);
    });

    test('should handle quoted arg with special characters', () => {
      const result = parseCommand('/command-invoke plan "Fix bug #123: handle edge case"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Fix bug #123: handle edge case']);
    });

    test('should handle empty quoted string', () => {
      const result = parseCommand('/command-invoke plan ""');
      expect(result.command).toBe('command-invoke');
      // Empty quotes get matched by \S+ and stripped, resulting in empty string
      expect(result.args).toEqual(['plan', '']);
    });
  });

  describe('business topic commands', () => {
    test('binds an absolute path and resets the current session', async () => {
      (sessionDb.getActiveSession as jest.Mock).mockResolvedValue({ id: 'session-1' });

      const result = await handleCommand(baseConversation, '/bind /tmp/repo-b', {
        lockManager: new ConversationLockManager(10),
      });

      expect(mkdir).toHaveBeenCalledWith('/tmp/repo-b', { recursive: true });
      expect(conversationDb.updateConversation).toHaveBeenCalledWith('conv-1', {
        cwd: '/tmp/repo-b',
      });
      expect(sessionDb.deactivateSession).toHaveBeenCalledWith('session-1');
      expect(result.message).toContain('Bound topic to: /tmp/repo-b');
    });

    test('rejects relative bind targets', async () => {
      const result = await handleCommand(baseConversation, '/bind repo-b', {
        lockManager: new ConversationLockManager(10),
      });

      expect(result).toEqual({
        success: false,
        message: 'Usage: /bind /absolute/path',
      });
    });

    test('reports running state, queue length, and the latest session outcome', async () => {
      const runtime = { lockManager: new ConversationLockManager(10) };
      jest.spyOn(runtime.lockManager, 'getConversationState').mockReturnValue({
        state: 'running',
        isActive: true,
        queueLength: 2,
      });

      (sessionDb.getActiveSession as jest.Mock).mockResolvedValue({
        id: 'session-1',
        assistant_session_id: 'codex-thread-1',
        metadata: { lastOutcome: 'completed' },
      });

      const result = await handleCommand(baseConversation, '/status', runtime);

      expect(result.message).toContain('Topic: repo-a');
      expect(result.message).toContain('Current state: running');
      expect(result.message).toContain('Queue length: 2');
      expect(result.message).toContain('Active session: codex-thread-1');
    });
  });
});
