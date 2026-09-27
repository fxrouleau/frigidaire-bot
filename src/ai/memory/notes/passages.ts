// Evidence passages (docs/memory.md "Evidence"): the messages a journal row cites (JournalEvidence
// messageIds), with a few messages around each, read back from archive.db. The nightly dream includes
// them for claims that are contested, low-confidence or about to become core profile facts, so its
// rewrite is grounded in what was actually said rather than in a chain of summaries. Internal input for
// the dream model only (never posted); deleted messages are left out, like everywhere else.
import { type ArchivedMessage, type ArchiveStore, getArchiveStore } from '../../../archive/archiveStore';
import { config } from '../../../config';
import { logger } from '../../../logger';
import { formatTimestampET } from '../../utils';
import { compareSnowflakeIds } from '../evidence';

/** One cited message and its surroundings, oldest first. */
export type EvidencePassage = {
  /** The cited message this passage is centered on. */
  anchorId: string;
  channelId: string;
  /** The channel's name when the archive knows it. */
  channelName: string | null;
  /** The anchor and the messages around it, oldest first. */
  messages: ArchivedMessage[];
};

export type EvidencePassageOptions = {
  /** Messages kept before / after each cited one (default 3 / 2). */
  before?: number;
  after?: number;
  /** Passages at most (default 8): the first cited ids win, so callers order ids by importance. */
  maxPassages?: number;
  /** The archive to read (default: the bot's shared one). The bootstrap CLI passes its own. */
  archive?: ArchiveStore;
};

export const EVIDENCE_PASSAGE_DEFAULTS = { before: 3, after: 2, maxPassages: 8, maxLineChars: 500 } as const;

/**
 * The passages around cited messages, in the order the ids are given (duplicates and ids already shown
 * inside an earlier passage are skipped; ids the archive doesn't hold, or holds as deleted, give none).
 * [] when the archive is off or unreadable: evidence is an aid, never a requirement.
 */
export function loadEvidencePassages(messageIds: string[], opts: EvidencePassageOptions = {}): EvidencePassage[] {
  if (!config.archive.enabled || messageIds.length === 0) return [];
  const before = Math.max(0, Math.floor(opts.before ?? EVIDENCE_PASSAGE_DEFAULTS.before));
  const after = Math.max(0, Math.floor(opts.after ?? EVIDENCE_PASSAGE_DEFAULTS.after));
  const max = Math.max(0, Math.floor(opts.maxPassages ?? EVIDENCE_PASSAGE_DEFAULTS.maxPassages));
  try {
    const store = opts.archive ?? getArchiveStore();
    const passages: EvidencePassage[] = [];
    const shown = new Set<string>();
    for (const id of messageIds) {
      if (passages.length >= max) break;
      if (shown.has(id)) continue;
      const anchor = store.getMessage(id);
      if (!anchor || anchor.deletedAt !== null) continue;
      const context = store.getContext(anchor, before, after);
      const messages = [...context.before, anchor, ...context.after];
      for (const m of messages) shown.add(m.id);
      passages.push({
        anchorId: anchor.id,
        channelId: anchor.channelId,
        channelName: store.getChannel(anchor.channelId)?.name ?? null,
        messages,
      });
    }
    return passages;
  } catch (error) {
    logger.warn('notes: reading evidence passages failed:', error);
    return [];
  }
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * A passage as prompt text: a `#channel` header, then one `YYYY-MM-DD HH:MM Name: text` line per message
 * (Eastern time), the cited one marked `>>`. Names come from `nameOf(authorId)` (the member's current
 * name) when given, else the name archived with the message; the bot's own lines read `bot:`. Voice
 * transcripts are inline, files as `[file: name]`.
 */
export function formatEvidencePassage(
  passage: EvidencePassage,
  nameOf: (authorId: string) => string | undefined = () => undefined,
): string {
  const header = `#${passage.channelName ?? passage.channelId}`;
  const lines = [...passage.messages]
    .sort((a, b) => a.createdAt - b.createdAt || compareSnowflakeIds(a.id, b.id))
    .map((m) => {
      const who = m.source === 'bot' ? 'bot' : ((m.authorId ? nameOf(m.authorId) : undefined) ?? m.authorName);
      const parts = [m.content];
      if (m.transcript) parts.push(`[voice: ${m.transcript}]`);
      for (const file of m.attachments) parts.push(`[file: ${file.name}]`);
      const text = clip(parts.filter((p) => p.trim()).join(' '), EVIDENCE_PASSAGE_DEFAULTS.maxLineChars);
      const mark = m.id === passage.anchorId ? '>> ' : '   ';
      return `${mark}${formatTimestampET(new Date(m.createdAt))} ${who}: ${text}`;
    });
  return [header, ...lines].join('\n');
}
