import { logger } from '../logger';
import { getMemoryStore } from './tools';

export type FailureCategory =
  | 'parse_failure'
  | 'tool_error'
  | 'missing_context'
  | 'unrecognized_content'
  | 'capability_gap';

export function logFailure(category: FailureCategory, content: string, source?: string): void {
  try {
    const store = getMemoryStore();
    store.save({
      category,
      subject: 'bot',
      content,
      source: source ?? 'self-diagnosis',
    });
  } catch (error) {
    logger.warn('Failed to log failure:', error);
  }
}
