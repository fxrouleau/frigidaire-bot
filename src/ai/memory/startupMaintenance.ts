// Memory maintenance run once at startup, in an order that matters: the subject-id stamp first, so rows
// it links to a member (name-only rows, rows filed under a side account's names or id) already share
// that member's id when compact() groups rows by person — they dedup on this start, not the next one.
import { logger } from '../../logger';
import type { MemoryStore } from './memoryStore';

export type StartupMaintenanceResult = { stamped: number; relinked: number; removed: number; expired: number };

/** Stamp, then compact. Each step logs and survives its own failure; the other still runs. */
export function runStartupMemoryMaintenance(store: MemoryStore): StartupMaintenanceResult {
  const result: StartupMaintenanceResult = { stamped: 0, relinked: 0, removed: 0, expired: 0 };

  // Link name-only memories to member ids (idempotent; logs its own counts).
  try {
    const stamp = store.stampSubjectUserIds();
    result.stamped = stamp.stamped;
    result.relinked = stamp.relinked;
  } catch (error) {
    logger.warn('Memory subject-id stamp on startup failed:', error);
  }

  try {
    const compaction = store.compact();
    result.removed = compaction.removed;
    result.expired = compaction.expired;
    if (compaction.removed > 0) {
      logger.info(`Memory compaction on startup: removed ${compaction.removed} duplicate memories.`);
    }
  } catch (error) {
    logger.warn('Memory compaction on startup failed:', error);
  }

  return result;
}
