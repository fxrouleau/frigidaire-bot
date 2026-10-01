// Pending shadow approvals: what a shadow line's Confirm button would do, one bot.db row per offer. Shadow
// mode (BIRTHDAY_ANNOUNCE_MODE, AUTO_REACT_MODE) only reports what live mode would have done; the owner
// can still let a good one through by clicking its button. The row holds everything the click needs (the
// button's custom_id only carries the row id), so a button keeps working across restarts until it expires.
//
// A row moves pending → working (claimed by a click, synchronously, so a double click acts once) → done,
// or back to pending when the action failed in a way a later click may fix. A claim left 'working' by a
// crash is taken over after STALE_CLAIM_MS.
import { type BotDb, getBotDb } from '../storage/botDb';

/** A birthday announcement written in shadow mode: Confirm posts `text` in the birthday channel. */
export type BirthdayApproval = {
  kind: 'birthday';
  userId: string;
  /** The year it is announced for (the real watermark Confirm moves). */
  year: number;
  channelId: string;
  text: string;
};

/** A reaction auto-react would have added: Confirm adds `emoji` to the post. */
export type ReactionApproval = {
  kind: 'auto_react';
  channelId: string;
  messageId: string;
  /** What discord.js' react() takes: a unicode emoji, or `name:id` / `a:name:id`. */
  emoji: string;
  /** How it reads in a message: the unicode emoji or `<:name:id>`. */
  label: string;
};

export type ApprovalPayload = BirthdayApproval | ReactionApproval;

export type Approval = {
  id: number;
  payload: ApprovalPayload;
  createdAt: number;
  expiresAt: number;
};

export type ClaimResult =
  | { status: 'claimed'; approval: Approval }
  | { status: 'unknown' | 'done' | 'busy' }
  | { status: 'expired'; approval: Approval };

const STALE_CLAIM_MS = 5 * 60_000;
// Rows are only needed while their button can act; a month covers looking one up afterwards.
const KEEP_MS = 30 * 24 * 60 * 60_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS shadow_approvals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT    NOT NULL,
    payload    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'pending',
    claimed_at INTEGER,
    decided_by TEXT,
    decided_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_shadow_approvals_created ON shadow_approvals(created_at);
`;

type Row = {
  id: number;
  kind: string;
  payload: string;
  created_at: number;
  expires_at: number;
  status: string;
  claimed_at: number | null;
};

function db(botDb: BotDb = getBotDb()): BotDb {
  botDb.ensureSchema('shadow_approvals', SCHEMA);
  return botDb;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The stored payload, type-checked; undefined for a row this build can't act on. */
function parsePayload(kind: string, json: string): ApprovalPayload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const fields = value as Record<string, unknown>;
  if (kind === 'birthday') {
    const { userId, year, channelId, text } = fields;
    if (!isString(userId) || !Number.isInteger(year) || !isString(channelId) || !isString(text)) return undefined;
    return { kind, userId, year: year as number, channelId, text };
  }
  if (kind === 'auto_react') {
    const { channelId, messageId, emoji, label } = fields;
    if (!isString(channelId) || !isString(messageId) || !isString(emoji) || !isString(label)) return undefined;
    return { kind, channelId, messageId, emoji, label };
  }
  return undefined;
}

function toApproval(row: Row): Approval | undefined {
  const payload = parsePayload(row.kind, row.payload);
  return payload ? { id: row.id, payload, createdAt: row.created_at, expiresAt: row.expires_at } : undefined;
}

/** Records an offer and returns its id (for the button). Also forgets rows past KEEP_MS. */
export function createApproval(payload: ApprovalPayload, now: number, expiresAt: number): number {
  const store = db();
  store.stmt('DELETE FROM shadow_approvals WHERE created_at < ?').run(now - KEEP_MS);
  const { kind, ...rest } = payload;
  const result = store
    .stmt('INSERT INTO shadow_approvals (kind, payload, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(kind, JSON.stringify(rest), now, expiresAt);
  return Number(result.lastInsertRowid);
}

/** Removes an offer whose report post never went out. */
export function deleteApproval(id: number): void {
  db().stmt('DELETE FROM shadow_approvals WHERE id = ?').run(id);
}

/**
 * Claims an offer for a click: pending (or a stale claim) → working. An expired offer is closed instead
 * (status done, nobody decided) and returned so the caller can say so.
 */
export function claimApproval(id: number, now: number): ClaimResult {
  const store = db();
  const row = store.stmt('SELECT * FROM shadow_approvals WHERE id = ?').get(id) as Row | undefined;
  if (!row) return { status: 'unknown' };
  if (row.status === 'done') return { status: 'done' };
  if (row.status === 'working' && row.claimed_at !== null && now - row.claimed_at < STALE_CLAIM_MS) {
    return { status: 'busy' };
  }
  const approval = toApproval(row);
  if (!approval) return { status: 'unknown' };
  if (now > row.expires_at) {
    store.stmt("UPDATE shadow_approvals SET status = 'done', decided_at = ? WHERE id = ?").run(now, id);
    return { status: 'expired', approval };
  }
  // Conditional on the status read above: whoever moves it first is the only one that acts.
  const claimed = store
    .stmt("UPDATE shadow_approvals SET status = 'working', claimed_at = ? WHERE id = ? AND status = ?")
    .run(now, id, row.status).changes;
  return claimed === 1 ? { status: 'claimed', approval } : { status: 'busy' };
}

/** The claimed offer was acted on (or can never be): closed for good. */
export function completeApproval(id: number, decidedBy: string, now: number): void {
  db()
    .stmt("UPDATE shadow_approvals SET status = 'done', decided_by = ?, decided_at = ? WHERE id = ?")
    .run(decidedBy, now, id);
}

/** The action failed in a way a later click may fix: the button works again. */
export function releaseApproval(id: number): void {
  db().stmt("UPDATE shadow_approvals SET status = 'pending', claimed_at = NULL WHERE id = ?").run(id);
}
