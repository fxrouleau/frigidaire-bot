// The archive's public surface for other features: read archived messages and run stats queries
// without knowing the storage details. Everything here excludes deleted messages.
import { config } from '../config';
import { logger } from '../logger';
import { type ArchivedMessage, getArchiveStore } from './archiveStore';

export type { ArchivedMessage, ArchiveSource } from './archiveStore';
export { computeWrappedStats, messageCountsByAuthor } from './stats';
export type { AuthorCount, StatsScope, WrappedStats } from './stats';

/**
 * A channel's archived messages in [startMs, endMs), oldest first — every source, so callers decide:
 * `source` is 'human' (a member), 'relay' (the bot's webhook repost of a member's message; authorId is
 * the member) or 'bot' (the bot itself). Returns [] when the archive is disabled or unavailable.
 */
export function getArchivedMessages(
  channelId: string,
  startMs: number,
  endMs: number,
  opts: { includeThreads?: boolean; limit?: number } = {},
): ArchivedMessage[] {
  if (!config.archive.enabled) return [];
  try {
    return getArchiveStore().getChannelMessages(channelId, startMs, endMs, opts);
  } catch (error) {
    logger.warn(`archive: reading channel ${channelId} failed:`, error);
    return [];
  }
}
