// What a captured observation cites (memory v2 evidence, docs/memory.md "Evidence"). The capture transcript
// numbers its lines (#1, #2, …) and the extractor answers each observation with the line numbers it came
// from, a short verbatim quote and, for a relationship or a shared thing, the other members it is also
// about. All of that is model output, so it is untrusted: line numbers resolve only to lines the request
// showed (never to an id the model typed), a quote is kept only when it really occurs in the messages, and
// related members must be known members. Cheaper and safer than asking for message ids: a line number is
// one or two tokens and cannot name a message the model never saw.
import { canonicalUserId } from '../../linkedAccounts';
import { clampQuote, EVIDENCE_LIMITS, type JournalEvidence, normalizeEvidence } from '../memory/evidence';
import { type Member, matchMemberByName } from '../people';

/** One numbered line of a capture request. */
export type TranscriptLine = {
  /** Its number in the request (#N). */
  line: number;
  /** The Discord id of the message it renders (archive.db key). */
  messageId: string;
  /**
   * Every message a line renders, oldest first, when it merges several (the bootstrap's `Name: a / b`
   * lines); citing the line cites them all. Default: [messageId].
   */
  messageIds?: string[];
  /** When the message was posted (epoch ms). */
  at: number;
  /** What the model read: the message text plus its voice transcript, if any. */
  text: string;
  /** Shown as context only (the lead-in before a segment). */
  leadIn: boolean;
};

/** Other members one observation may name as also involved. */
export const MAX_RELATED_MEMBERS = 10;

const SNOWFLAKE = /^\d{15,21}$/;
const LINE_REF = /^#?\s*(\d{1,6})$/;
// Straight and typographic quote marks, and ellipses, that models put around or inside a quote.
const QUOTE_MARKS = /^[\s"'`“”‘’«»]+|[\s"'`“”‘’«»]+$/g;
const ELLIPSIS = /\s*(?:\.{3,}|…)\s*/;

/** Text folded for quote matching: compatibility forms, case, typographic quotes and whitespace ignored. */
function foldText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’`]/g, "'")
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The quote's pieces to look for, in order: it may elide the middle of a message with "…" or "...". */
function quotePieces(quote: string): string[] {
  const trimmed = quote.replace(QUOTE_MARKS, '').replace(/^(?:\.{3,}|…)+|(?:\.{3,}|…)+$/g, '');
  return trimmed
    .split(ELLIPSIS)
    .map((piece) => foldText(piece.replace(QUOTE_MARKS, '')))
    .filter((piece) => piece.length > 0);
}

/** Whether every piece occurs in `text`, in order. */
function occursIn(pieces: string[], text: string): boolean {
  const folded = foldText(text);
  let from = 0;
  for (const piece of pieces) {
    const at = folded.indexOf(piece, from);
    if (at < 0) return false;
    from = at + piece.length;
  }
  return pieces.length > 0;
}

/** Line numbers from untrusted input: numbers, "12" or "#12"; anything else is dropped. */
function lineNumbers(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const numbers: number[] = [];
  for (const entry of list) {
    if (typeof entry === 'number' && Number.isInteger(entry)) numbers.push(entry);
    else if (typeof entry === 'string') {
      const match = entry.trim().match(LINE_REF);
      if (match) numbers.push(Number(match[1]));
    }
  }
  return numbers;
}

/**
 * The evidence an observation cites, resolved against the lines its request showed: `{lines, quote}` under
 * `evidence` (or the bare fields on the observation; a bare array under `evidence` is read as lines).
 * Unknown line numbers are dropped. The quote is kept only when it occurs in a cited line (or across the
 * cited lines read together); one that occurs in another shown line cites that line too; one that occurs
 * nowhere is dropped (the dream rereads quotes as what was actually said). `observedAt` is when the newest
 * cited message was posted, for the row's first/last seen.
 */
export function citedEvidence(
  observation: Record<string, unknown>,
  lines: ReadonlyMap<number, TranscriptLine>,
): { evidence?: JournalEvidence; observedAt?: Date } {
  const raw = observation.evidence;
  const fields: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rawLines = Array.isArray(raw) ? raw : (fields.lines ?? fields.line ?? observation.lines);
  const cited = new Map<number, TranscriptLine>();
  for (const n of lineNumbers(rawLines)) {
    const line = lines.get(n);
    if (line && cited.size < EVIDENCE_LIMITS.maxMessageIds) cited.set(n, line);
  }

  let quote = clampQuote(fields.quote ?? observation.quote);
  if (quote) {
    const pieces = quotePieces(quote);
    const citedLines = [...cited.values()].sort((a, b) => a.line - b.line);
    const inCited =
      citedLines.some((line) => occursIn(pieces, line.text)) ||
      (citedLines.length > 1 && occursIn(pieces, citedLines.map((line) => line.text).join(' ')));
    if (!inCited) {
      // Conversation lines before lead-in lines; the first match in reading order.
      const others = [...lines.values()]
        .filter((line) => !cited.has(line.line))
        .sort((a, b) => Number(a.leadIn) - Number(b.leadIn) || a.line - b.line);
      const found = others.find((line) => occursIn(pieces, line.text));
      if (found && cited.size < EVIDENCE_LIMITS.maxMessageIds) cited.set(found.line, found);
      else quote = undefined;
    }
  }

  const citedLines = [...cited.values()];
  const evidence = normalizeEvidence({
    messageIds: citedLines.flatMap((line) => line.messageIds ?? [line.messageId]),
    quote,
  });
  const newest = citedLines.reduce<number | undefined>(
    (max, line) => (max === undefined || line.at > max ? line.at : max),
    undefined,
  );
  return { ...(evidence ? { evidence } : {}), ...(newest !== undefined ? { observedAt: new Date(newest) } : {}) };
}

/**
 * The other members an observation names as also involved (`related_user_ids`, or `related`): Discord ids
 * of known members (a side account's counts as its member) or names that resolve to exactly one member.
 * Main ids, deduped, in the given order, the subject left out, at most MAX_RELATED_MEMBERS.
 */
export function relatedMembers(
  observation: Record<string, unknown>,
  members: readonly Member[],
  subjectUserId: string | undefined,
): string[] {
  const raw = observation.related_user_ids ?? observation.related;
  const list = Array.isArray(raw) ? raw : [];
  const known = new Set(members.map((m) => m.userId));
  const subject = subjectUserId ? canonicalUserId(subjectUserId) : undefined;
  const related: string[] = [];
  for (const entry of list) {
    // A JSON number cannot hold a snowflake exactly (18+ digits exceed 2^53): only strings count.
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const value = entry.trim();
    let id: string | undefined;
    if (SNOWFLAKE.test(value)) {
      const main = canonicalUserId(value);
      id = known.has(main) ? main : undefined;
    } else {
      id = matchMemberByName([...members], value)?.userId;
    }
    if (!id || id === subject || related.includes(id)) continue;
    related.push(id);
    if (related.length >= MAX_RELATED_MEMBERS) break;
  }
  return related;
}
