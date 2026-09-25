// The auto-react ledger: one bot.db row per reaction the bot added on its own (or, in shadow mode, would
// have added). It lives in bot.db rather than memory so that a deploy never resets the budget ("3 a day"
// must mean 3, not 3 per restart) and "never twice on the same message" holds across restarts too.
// Shadow rows count against the budget like real ones: shadow output is meant to show exactly what live
// mode would have done, budget included.
import { type BotDb, getBotDb } from '../storage/botDb';

export type AutoReactRecord = {
  messageId: string;
  channelId: string;
  /** What was (or would have been) reacted with: `<:name:id>` for a server emoji, else the unicode emoji. */
  emoji: string;
  why: string;
  mode: 'shadow' | 'on';
  createdAt: number;
};

export type BudgetLimits = {
  /** Reactions allowed in any rolling 24 hours. */
  maxPerDay: number;
  /** Minimum time between two reactions. */
  minGapMs: number;
};

export type BudgetVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'daily_cap' | 'gap';
      /** When the budget opens up again (epoch ms). */
      until: number;
    };

const DAY_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS auto_reactions (
    message_id TEXT    PRIMARY KEY,
    channel_id TEXT    NOT NULL,
    emoji      TEXT    NOT NULL,
    why        TEXT    NOT NULL,
    mode       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auto_reactions_created ON auto_reactions(created_at);
`;

type Row = {
  message_id: string;
  channel_id: string;
  emoji: string;
  why: string;
  mode: 'shadow' | 'on';
  created_at: number;
};

function toRecord(row: Row): AutoReactRecord {
  return {
    messageId: row.message_id,
    channelId: row.channel_id,
    emoji: row.emoji,
    why: row.why,
    mode: row.mode,
    createdAt: row.created_at,
  };
}

export class AutoReactLedger {
  constructor(private readonly botDb: () => BotDb = getBotDb) {}

  private db(): BotDb {
    const db = this.botDb();
    db.ensureSchema('auto_reactions', SCHEMA);
    return db;
  }

  /** Whether another reaction fits the budget right now. */
  check(now: number, limits: BudgetLimits): BudgetVerdict {
    if (limits.maxPerDay <= 0) return { allowed: false, reason: 'daily_cap', until: Number.POSITIVE_INFINITY };
    const recent = this.db()
      .stmt('SELECT created_at FROM auto_reactions WHERE created_at > ? ORDER BY created_at ASC')
      .all(now - DAY_MS) as { created_at: number }[];
    if (recent.length >= limits.maxPerDay) {
      // The window reopens when the oldest reaction that still counts turns 24 hours old.
      const oldestCounting = recent[recent.length - limits.maxPerDay].created_at;
      return { allowed: false, reason: 'daily_cap', until: oldestCounting + DAY_MS };
    }
    const last = this.db().stmt('SELECT MAX(created_at) AS at FROM auto_reactions').get() as { at: number | null };
    if (last.at !== null && now - last.at < limits.minGapMs) {
      return { allowed: false, reason: 'gap', until: last.at + limits.minGapMs };
    }
    return { allowed: true };
  }

  has(messageId: string): boolean {
    return this.db().stmt('SELECT 1 FROM auto_reactions WHERE message_id = ?').get(messageId) !== undefined;
  }

  /**
   * Records a reaction before it is sent (so two decisions finishing together can't both spend the last
   * slot). False when the message already has one.
   */
  claim(record: AutoReactRecord): boolean {
    return (
      this.db()
        .stmt(
          `INSERT INTO auto_reactions (message_id, channel_id, emoji, why, mode, created_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`,
        )
        .run(record.messageId, record.channelId, record.emoji, record.why, record.mode, record.createdAt).changes > 0
    );
  }

  /** Gives a claimed slot back (the reaction could not be sent). */
  release(messageId: string): void {
    this.db().stmt('DELETE FROM auto_reactions WHERE message_id = ?').run(messageId);
  }

  /** Reactions since `sinceMs`, newest first. */
  since(sinceMs: number): AutoReactRecord[] {
    const rows = this.db()
      .stmt('SELECT * FROM auto_reactions WHERE created_at >= ? ORDER BY created_at DESC')
      .all(sinceMs) as Row[];
    return rows.map(toRecord);
  }
}
