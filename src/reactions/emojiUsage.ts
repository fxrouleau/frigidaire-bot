// How the group actually uses each custom emoji, from the message archive: the posts people reacted to
// with it (reactions_json, via the reaction profile) and the messages it was typed in, with the message
// it answered when the emoji is most of the message (a bare ":SAJ:" means nothing without what it
// answers). Feeds the usage-grounded emoji captions (usageCaptions.ts).
//
// Typed uses are found through the archive's FTS index: `<:name:id>` tokenizes into the name and the
// numeric id, so the id is a precise, indexed key (a LIKE scan over every message would read the whole
// table per emoji). Like the Wrapped stats, this reads the archive's tables directly.
import type { ArchivedMessage, ArchiveStore } from '../archive/archiveStore';
import { getArchiveStore, notIgnoredChannelsFilter } from '../archive/archiveStore';
import { getReactionProfile } from '../archive/reactions';
import { config } from '../config';
import { logger } from '../logger';
import { readableEmojiText } from './guide';

export type EmojiUsageSample = {
  kind: 'reaction' | 'message';
  /** The post reacted to, or the message the emoji was typed in (custom emojis made readable). */
  text: string;
  /** For a typed use that is mostly the emoji: the message it answered. */
  before?: string;
};

export type EmojiUsage = {
  id: string;
  /** Member reactions with it (the bot's own excluded). */
  reactionUses: number;
  /** Member messages it was typed in (a message counts once, however many times it repeats the emoji). */
  messageUses: number;
  total: number;
  samples: EmojiUsageSample[];
};

export const DEFAULT_MAX_SAMPLES = 20;
// The reaction profile ranks every emoji ever used; this bounds the query, not the server's emoji count.
const PROFILE_LIMIT = 1000;
const SAMPLE_CHARS = 160;
// A typed use with less text than this besides the emoji needs the message it answered to mean anything.
const BARE_USE_CHARS = 25;

function clip(text: string): string {
  const flat = readableEmojiText(text).replace(/\s+/g, ' ').trim();
  return flat.length > SAMPLE_CHARS ? `${flat.slice(0, SAMPLE_CHARS - 1)}…` : flat;
}

type TypedRow = { id: string; content: string; reply_to_id: string | null };

/** Member messages (newest first, ARCHIVE_IGNORE_CHANNELS left out) that contain the custom emoji `id`. */
function typedUses(store: ArchiveStore, id: string): TypedRow[] {
  const notIgnored = notIgnoredChannelsFilter('m');
  const rows = store.db
    .prepare(
      `SELECT m.id, m.content, m.reply_to_id FROM messages_fts JOIN messages m ON m.seq = messages_fts.rowid
       WHERE messages_fts MATCH @match AND m.deleted_at IS NULL AND m.source IN ('human', 'relay')
         ${notIgnored ? `AND ${notIgnored.sql}` : ''}
       ORDER BY m.created_at DESC`,
    )
    .all({ match: `content : "${id}"`, ...notIgnored?.params }) as TypedRow[];
  // The index matches the id as a word anywhere in the text; only an actual emoji token counts.
  const token = new RegExp(`<a?:\\w+:${id}>`);
  return rows.filter((row) => token.test(row.content));
}

function answeredMessage(store: ArchiveStore, row: TypedRow): ArchivedMessage | undefined {
  if (row.reply_to_id) {
    const replied = store.getMessage(row.reply_to_id);
    if (replied && replied.deletedAt === null) return replied;
  }
  const self = store.getMessage(row.id);
  return self ? store.getContext(self, 1, 0).before[0] : undefined;
}

function typedSample(store: ArchiveStore, row: TypedRow): EmojiUsageSample {
  const text = clip(row.content);
  const rest = row.content.replace(/<a?:\w+:\d+>/g, '').trim();
  if (rest.length >= BARE_USE_CHARS) return { kind: 'message', text };
  const before = answeredMessage(store, row);
  const beforeText = before ? clip(before.content) : '';
  return beforeText ? { kind: 'message', text, before: beforeText } : { kind: 'message', text };
}

/**
 * Up to `max` samples, split between reactions and typed uses in proportion to how the emoji is used,
 * with a few of each kind whenever both exist (one kind rarely tells the whole story).
 */
export function mixSamples(
  reactions: EmojiUsageSample[],
  messages: EmojiUsageSample[],
  reactionUses: number,
  messageUses: number,
  max: number,
): EmojiUsageSample[] {
  const total = reactionUses + messageUses;
  if (total === 0 || max <= 0) return [];
  const floor = Math.min(3, Math.floor(max / 2));
  let reactionShare = Math.round((max * reactionUses) / total);
  if (reactions.length > 0 && messages.length > 0) {
    reactionShare = Math.min(Math.max(reactionShare, floor), max - floor);
  }
  const pickedReactions = reactions.slice(0, reactionShare);
  // Whatever one side can't fill goes to the other.
  const pickedMessages = messages.slice(0, max - pickedReactions.length);
  const room = max - pickedReactions.length - pickedMessages.length;
  const extraReactions = reactions.slice(pickedReactions.length, pickedReactions.length + room);
  return [...pickedReactions, ...extraReactions, ...pickedMessages];
}

/** Usage of each of these custom emojis in the archive. Emojis never used are absent. Never throws. */
export function collectEmojiUsage(
  emojiIds: string[],
  opts: { store?: ArchiveStore; maxSamples?: number } = {},
): Map<string, EmojiUsage> {
  const result = new Map<string, EmojiUsage>();
  if (!config.archive.enabled || emojiIds.length === 0) return result;
  const maxSamples = opts.maxSamples ?? DEFAULT_MAX_SAMPLES;
  try {
    const store = opts.store ?? getArchiveStore();
    const wanted = new Set(emojiIds);
    const profile = getReactionProfile({ limit: PROFILE_LIMIT, samplesPerEmoji: maxSamples }, store);
    const reacted = new Map(profile.emojis.filter((e) => e.id && wanted.has(e.id)).map((e) => [e.id as string, e]));

    for (const id of wanted) {
      // Ids come from the emoji table (snowflakes); anything else must never reach the MATCH expression.
      if (!/^\d+$/.test(id)) continue;
      const reaction = reacted.get(id);
      const typed = typedUses(store, id);
      const reactionUses = reaction?.uses ?? 0;
      if (reactionUses === 0 && typed.length === 0) continue;

      const reactionSamples: EmojiUsageSample[] = (reaction?.samples ?? [])
        .filter((s) => s.snippet !== '(no text)')
        .map((s) => ({ kind: 'reaction', text: clip(s.snippet) }));
      // The newest typed uses: how the group uses it now. The count still covers every use.
      const messageSamples = typed.slice(0, maxSamples).map((row) => typedSample(store, row));
      result.set(id, {
        id,
        reactionUses,
        messageUses: typed.length,
        total: reactionUses + typed.length,
        samples: mixSamples(reactionSamples, messageSamples, reactionUses, typed.length, maxSamples),
      });
    }
  } catch (error) {
    logger.warn('emojiUsage: reading emoji usage from the archive failed:', error);
  }
  return result;
}

/** One prompt line per sample. */
export function formatUsageSample(sample: EmojiUsageSample): string {
  if (sample.kind === 'reaction') return `- reacted to: "${sample.text}"`;
  if (sample.before) return `- replying to "${sample.before}": "${sample.text}"`;
  return `- in a message: "${sample.text}"`;
}
