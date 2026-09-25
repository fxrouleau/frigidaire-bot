// Reminders live in bot.db, so a pending reminder survives restarts and redeploys: the scheduler just
// picks up whatever is due when it next ticks.
//
// Delivery is claim-then-send: a tick flips a due row from 'pending' to 'sending' in one conditional
// UPDATE before posting it, so two overlapping ticks (or two processes during a deploy) can never both
// post the same reminder. A row a dead process left in 'sending' is released back to 'pending' after a
// grace period; the re-send carries the same Discord nonce, which Discord deduplicates for a few minutes.
import { getBotDb } from '../storage/botDb';

export type ReminderStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';

export type Reminder = {
  id: number;
  guildId: string | null;
  channelId: string;
  requesterId: string;
  requesterName: string;
  targetIds: string[];
  text: string;
  /** Epoch ms. */
  dueAt: number;
  sourceUrl: string | null;
  status: ReminderStatus;
  attempts: number;
  nextAttemptAt: number | null;
  createdAt: number;
};

type ReminderRow = {
  id: number;
  guild_id: string | null;
  channel_id: string;
  requester_id: string;
  requester_name: string;
  target_ids: string;
  text: string;
  due_at: number;
  source_url: string | null;
  status: ReminderStatus;
  attempts: number;
  next_attempt_at: number | null;
  created_at: number;
};

// AUTOINCREMENT: ids are never reused, so an id quoted in an old conversation (or a Discord nonce built
// from it) can never point at a different, newer reminder.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS reminders (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id         TEXT,
    channel_id       TEXT    NOT NULL,
    requester_id     TEXT    NOT NULL,
    requester_name   TEXT    NOT NULL,
    target_ids       TEXT    NOT NULL,
    text             TEXT    NOT NULL,
    due_at           INTEGER NOT NULL,
    source_url       TEXT,
    status           TEXT    NOT NULL DEFAULT 'pending',
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  INTEGER,
    claimed_at       INTEGER,
    sent_at          INTEGER,
    sent_message_id  TEXT,
    sent_channel_id  TEXT,
    last_error       TEXT,
    cancelled_by     TEXT,
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_status_due ON reminders(status, due_at);
  CREATE INDEX IF NOT EXISTS idx_reminders_channel ON reminders(channel_id, status);
  CREATE INDEX IF NOT EXISTS idx_reminders_requester ON reminders(requester_id, status);
`;

function db() {
  const botDb = getBotDb();
  botDb.ensureSchema('reminders', SCHEMA);
  return botDb;
}

function toReminder(row: ReminderRow): Reminder {
  let targetIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.target_ids);
    if (Array.isArray(parsed)) targetIds = parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // A corrupt target list degrades to "nobody to ping"; the requester still sees it in list_reminders.
  }
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    requesterId: row.requester_id,
    requesterName: row.requester_name,
    targetIds,
    text: row.text,
    dueAt: row.due_at,
    sourceUrl: row.source_url,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
  };
}

export type NewReminder = {
  guildId: string | null;
  channelId: string;
  requesterId: string;
  requesterName: string;
  targetIds: string[];
  text: string;
  dueAt: number;
  sourceUrl: string | null;
  createdAt: number;
};

export function insertReminder(input: NewReminder): number {
  const result = db()
    .stmt(
      `INSERT INTO reminders (guild_id, channel_id, requester_id, requester_name, target_ids, text, due_at, source_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.guildId,
      input.channelId,
      input.requesterId,
      input.requesterName,
      JSON.stringify(input.targetIds),
      input.text,
      input.dueAt,
      input.sourceUrl,
      input.createdAt,
    );
  return Number(result.lastInsertRowid);
}

export function getReminder(id: number): Reminder | undefined {
  const row = db().stmt('SELECT * FROM reminders WHERE id = ?').get(id) as ReminderRow | undefined;
  return row ? toReminder(row) : undefined;
}

/** Reminders a member has set that have not gone off yet (the per-user cap counts these). */
export function countOpenByRequester(requesterId: string): number {
  const row = db()
    .stmt("SELECT COUNT(*) AS n FROM reminders WHERE requester_id = ? AND status IN ('pending', 'sending')")
    .get(requesterId) as { n: number };
  return row.n;
}

export function listPendingInChannel(channelId: string): Reminder[] {
  const rows = db()
    .stmt("SELECT * FROM reminders WHERE channel_id = ? AND status IN ('pending', 'sending') ORDER BY due_at, id")
    .all(channelId) as ReminderRow[];
  return rows.map(toReminder);
}

export type CancelOutcome =
  | { outcome: 'cancelled'; reminder: Reminder }
  | { outcome: 'not_found' }
  | { outcome: 'forbidden'; reminder: Reminder }
  | { outcome: 'not_pending'; reminder: Reminder };

/** Cancels a pending reminder; only its requester or one of its targets may. */
export function cancelReminder(id: number, actorId: string): CancelOutcome {
  const store = db();
  return store.transaction((): CancelOutcome => {
    const reminder = getReminder(id);
    if (!reminder) return { outcome: 'not_found' };
    if (reminder.requesterId !== actorId && !reminder.targetIds.includes(actorId)) {
      return { outcome: 'forbidden', reminder };
    }
    const changed = store
      .stmt("UPDATE reminders SET status = 'cancelled', cancelled_by = ? WHERE id = ? AND status = 'pending'")
      .run(actorId, id).changes;
    return changed === 1 ? { outcome: 'cancelled', reminder } : { outcome: 'not_pending', reminder };
  });
}

/**
 * Claims up to `limit` due reminders for delivery (oldest first): each is flipped to 'sending' and its
 * attempt counter bumped. Only rows this call actually flipped are returned.
 */
export function claimDueReminders(now: number, limit: number): Reminder[] {
  const store = db();
  return store.transaction(() => {
    const due = store
      .stmt(
        `SELECT * FROM reminders
         WHERE status = 'pending' AND due_at <= ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY due_at, id LIMIT ?`,
      )
      .all(now, now, limit) as ReminderRow[];
    const claimed: Reminder[] = [];
    for (const row of due) {
      const changed = store
        .stmt(
          "UPDATE reminders SET status = 'sending', attempts = attempts + 1, claimed_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(now, row.id).changes;
      if (changed === 1) claimed.push(toReminder({ ...row, status: 'sending', attempts: row.attempts + 1 }));
    }
    return claimed;
  });
}

export function markSent(id: number, sent: { messageId: string; channelId: string; at: number }): void {
  db()
    .stmt(
      `UPDATE reminders SET status = 'sent', sent_at = ?, sent_message_id = ?, sent_channel_id = ?, last_error = NULL
       WHERE id = ? AND status = 'sending'`,
    )
    .run(sent.at, sent.messageId, sent.channelId, id);
}

/** Puts a claimed reminder back in the queue, not before `nextAttemptAt`. */
export function markRetry(id: number, error: string, nextAttemptAt: number): void {
  db()
    .stmt(
      "UPDATE reminders SET status = 'pending', next_attempt_at = ?, last_error = ? WHERE id = ? AND status = 'sending'",
    )
    .run(nextAttemptAt, error.slice(0, 500), id);
}

export function markFailed(id: number, error: string): void {
  db()
    .stmt("UPDATE reminders SET status = 'failed', last_error = ? WHERE id = ? AND status = 'sending'")
    .run(error.slice(0, 500), id);
}

/** Releases claims older than `staleMs` (their process died mid-send). Returns how many were released. */
export function releaseStaleClaims(now: number, staleMs: number): number {
  return db()
    .stmt("UPDATE reminders SET status = 'pending' WHERE status = 'sending' AND claimed_at < ?")
    .run(now - staleMs).changes;
}

/** Deletes finished (sent/failed/cancelled) reminders older than `maxAgeMs`. Returns how many. */
export function pruneFinished(now: number, maxAgeMs: number): number {
  return db()
    .stmt("DELETE FROM reminders WHERE status IN ('sent', 'failed', 'cancelled') AND due_at < ?")
    .run(now - maxAgeMs).changes;
}
