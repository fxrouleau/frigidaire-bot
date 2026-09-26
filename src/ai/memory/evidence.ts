// Journal evidence (memory v2, docs/memory.md "Evidence"): the key passage a journal row was learned from.
// Capture fills it from the conversation it read; remember_fact and record_correction fill the message that
// triggered them. The nightly dream fetches the cited messages (± a few around them) from archive.db for
// contested, low-confidence or core claims, so a rewrite is grounded in what was actually said rather than
// in a chain of summaries (src/ai/memory/notes/passages.ts).
//
// Stored as JSON in memories.evidence. Everything here treats the input as untrusted (a model writes most
// of it): ids must look like Discord ids, the quote is one clamped line, and bad input yields undefined
// (no evidence), never a throw.

/** The key passage behind a journal row. */
export type JournalEvidence = {
  /**
   * Discord ids of the messages the row was learned from (archive.db keys), oldest first. A row that
   * recurred keeps the first few and the newest (EVIDENCE_LIMITS.maxMessageIds).
   */
  messageIds: string[];
  /** A short verbatim excerpt of the key passage (≤ EVIDENCE_LIMITS.quoteMaxChars, one line). */
  quote?: string;
};

export const EVIDENCE_LIMITS = {
  quoteMaxChars: 240,
  maxMessageIds: 12,
  /** When a merge passes maxMessageIds: this many of the oldest ids are kept (where it started), the rest newest. */
  keepOldest: 3,
} as const;

const SNOWFLAKE = /^\d{15,21}$/;
// Control characters other than tab/newline (those collapse to a space anyway).
// biome-ignore lint/suspicious/noControlCharactersInRegex: this pattern exists to strip control characters.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Discord snowflakes sort by time: shorter first, then lexicographically. */
export function compareSnowflakeIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A quote as one clamped line, or undefined when empty. */
export function clampQuote(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const line = raw.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  const max = EVIDENCE_LIMITS.quoteMaxChars;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Keeps the oldest EVIDENCE_LIMITS.keepOldest ids and fills the rest of the cap with the newest. */
function capIds(sortedIds: string[]): string[] {
  const max = EVIDENCE_LIMITS.maxMessageIds;
  if (sortedIds.length <= max) return sortedIds;
  const oldest = sortedIds.slice(0, EVIDENCE_LIMITS.keepOldest);
  const newest = sortedIds.slice(sortedIds.length - (max - oldest.length));
  return [...oldest, ...newest];
}

/**
 * Untrusted evidence (a model's `{messageIds|message_ids, quote}`, a tool's input, a stored JSON string) as a
 * JournalEvidence: snowflake-shaped ids only (deduped, sorted, capped), the quote clamped. Undefined when
 * nothing usable is left.
 */
export function normalizeEvidence(raw: unknown): JournalEvidence | undefined {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  const rawIds = Array.isArray(fields.messageIds)
    ? fields.messageIds
    : Array.isArray(fields.message_ids)
      ? fields.message_ids
      : [];
  const ids = [
    ...new Set(
      rawIds
        .map((id) => (typeof id === 'number' ? String(id) : id))
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => SNOWFLAKE.test(id)),
    ),
  ].sort(compareSnowflakeIds);
  const quote = clampQuote(fields.quote);
  if (ids.length === 0 && !quote) return undefined;
  return { messageIds: capIds(ids), ...(quote ? { quote } : {}) };
}

/**
 * Two observations of the same thing folded together (a dedup merge): the ids of both, oldest first and
 * capped (the first few are kept: where it started), and the newer observation's quote when it has one.
 */
export function mergeEvidence(
  older: JournalEvidence | undefined,
  newer: JournalEvidence | undefined,
): JournalEvidence | undefined {
  if (!older) return newer;
  if (!newer) return older;
  const ids = [...new Set([...older.messageIds, ...newer.messageIds])].sort(compareSnowflakeIds);
  const quote = newer.quote ?? older.quote;
  return { messageIds: capIds(ids), ...(quote ? { quote } : {}) };
}

/** The stored form (memories.evidence), or null for no evidence. */
export function serializeEvidence(evidence: JournalEvidence | undefined): string | null {
  const normalized = normalizeEvidence(evidence);
  return normalized ? JSON.stringify(normalized) : null;
}

/** A row's stored evidence, or undefined (missing or unreadable). */
export function parseEvidence(stored: string | null | undefined): JournalEvidence | undefined {
  return stored ? normalizeEvidence(stored) : undefined;
}

/** Evidence citing one message (remember_fact, record_correction: the message that triggered them). */
export function evidenceFromMessage(messageId: string | undefined, quote?: string): JournalEvidence | undefined {
  return normalizeEvidence({ messageIds: messageId ? [messageId] : [], quote });
}
