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
    // Fire-and-forget: save() writes the row synchronously before its first await (so the failure
    // is durable when this returns); only the async embedding phase, if any, completes later.
    void store
      .save({
        category,
        subject: 'bot',
        content,
        source: source ?? 'self-diagnosis',
      })
      .catch((error) => logger.warn('Failed to log failure:', error));
  } catch (error) {
    logger.warn('Failed to log failure:', error);
  }
}
