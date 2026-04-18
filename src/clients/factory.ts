/**
 * AI Assistant Client Factory
 *
 * Codex-only assistant factory.
 */
import { IAssistantClient } from '../types';
import { CodexClient } from './codex';

/**
 * Get the Codex assistant client.
 */
export function getAssistantClient(_type?: string): IAssistantClient {
  return new CodexClient();
}
