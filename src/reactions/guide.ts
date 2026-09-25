import type { EmojiRow } from '../ai/memory/memoryStore';
// "How this group reacts": a compact guide built from the archive's reaction profile (years of reaction
// counts, see src/archive/reactions.ts) that the auto-react judge reads before deciding. Per emoji: how
// often members used it and a few posts it landed on, most used first. The guide also carries the base
// rate (the share of member posts that got any reaction at all), which is what the bot's own rate has
// to stay far below.
//
// Only emojis the bot can actually use make it in: unicode ones, and custom ones still on the server
// (active rows of the emoji table). A deleted server emoji can't be reacted with, so teaching it would
// only produce rejected answers.
import { type ReactionProfile, type ReactionProfileEntry, getReactionProfile } from '../archive';

/** Emojis shown in the guide. */
export const GUIDE_EMOJIS = 25;
/** Example posts per emoji. */
export const GUIDE_EXAMPLES = 3;
const EXAMPLE_CHARS = 100;

export type GuideEmoji = {
  /** How the model names it: `:name:` for a server emoji, the emoji itself for unicode. */
  label: string;
  /** Custom emoji id; null for unicode. */
  id: string | null;
  name: string;
  uses: number;
  messages: number;
  /** A server emoji's caption ("<visual>; for <meaning>"): the judge can't see custom emoji images. */
  caption?: string;
  examples: string[];
};

export type ReactionGuide = {
  /** Member posts in scope. */
  messages: number;
  /** Of those, posts that got at least one member reaction (what "learn first" counts). */
  reactedMessages: number;
  baseRate: number;
  emojis: GuideEmoji[];
  /** The guide as the judge's prompt shows it ('' when there is nothing to show). */
  text: string;
  builtAt: number;
};

/**
 * Sums per-channel profiles into one: counts add up, and each emoji keeps its best examples (text
 * first, then the most-reacted, as the archive ranks them). Channels are disjoint, so nothing is
 * counted twice unless the same channel is listed twice.
 */
export function mergeProfiles(profiles: ReactionProfile[]): ReactionProfile {
  const byKey = new Map<string, ReactionProfileEntry>();
  let messages = 0;
  let reactedMessages = 0;
  for (const profile of profiles) {
    messages += profile.messages;
    reactedMessages += profile.reactedMessages;
    for (const entry of profile.emojis) {
      const existing = byKey.get(entry.key);
      if (!existing) {
        byKey.set(entry.key, { ...entry, samples: [...entry.samples] });
        continue;
      }
      existing.uses += entry.uses;
      existing.messages += entry.messages;
      if (entry.lastUsedAt > existing.lastUsedAt) {
        existing.lastUsedAt = entry.lastUsedAt;
        existing.name = entry.name;
      }
      existing.samples.push(...entry.samples);
    }
  }
  const emojis = [...byKey.values()]
    .map((entry) => ({
      ...entry,
      samples: entry.samples
        .sort(
          (a, b) =>
            Number(b.snippet !== '(no text)') - Number(a.snippet !== '(no text)') ||
            b.count - a.count ||
            b.createdAt - a.createdAt,
        )
        .slice(0, GUIDE_EXAMPLES),
    }))
    .sort((a, b) => b.uses - a.uses || b.messages - a.messages || a.key.localeCompare(b.key));
  return { messages, reactedMessages, baseRate: messages > 0 ? reactedMessages / messages : 0, emojis };
}

/** Custom emoji tokens read as `:name:` in prompts (the ids are noise to a model). */
export function readableEmojiText(text: string): string {
  return text.replace(/<a?:(\w+):\d+>/g, ':$1:');
}

function example(snippet: string): string {
  const flat = readableEmojiText(snippet).replace(/\s+/g, ' ').trim();
  const cut = flat.length > EXAMPLE_CHARS ? `${flat.slice(0, EXAMPLE_CHARS - 1)}…` : flat;
  return `"${cut.replace(/"/g, "'")}"`;
}

function percent(rate: number): string {
  const value = rate * 100;
  return value >= 10 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`;
}

/** The guide for a profile, keeping only emojis the bot can use (see the file comment). */
export function buildReactionGuide(profile: ReactionProfile, usableEmojis: EmojiRow[], now: number): ReactionGuide {
  const usable = new Map(usableEmojis.map((e) => [e.id, e]));
  const emojis: GuideEmoji[] = [];
  for (const entry of profile.emojis) {
    if (emojis.length >= GUIDE_EMOJIS) break;
    let label: string;
    let name = entry.name;
    let caption: string | undefined;
    if (entry.id) {
      const row = usable.get(entry.id);
      if (!row) continue;
      name = row.name; // the server's current name: that is what the judge must answer with
      label = `:${row.name}:`;
      caption = row.caption ?? undefined;
    } else {
      label = entry.name;
    }
    const examples = entry.samples
      .filter((s) => s.snippet !== '(no text)')
      .slice(0, GUIDE_EXAMPLES)
      .map((s) => example(s.snippet));
    emojis.push({ label, id: entry.id, name, uses: entry.uses, messages: entry.messages, caption, examples });
  }

  const lines: string[] = [];
  if (profile.messages > 0) {
    lines.push(
      `About ${percent(profile.baseRate)} of member posts here get any reaction at all (${profile.reactedMessages} of ${profile.messages}).`,
    );
  }
  if (emojis.length > 0) {
    lines.push(
      'Their reactions, most used first — emoji (times used) [what a server emoji shows; for what]: posts it landed on',
    );
    for (const e of emojis) {
      const caption = e.caption ? ` [${e.caption}]` : '';
      const examples = e.examples.length > 0 ? ` — ${e.examples.join(' · ')}` : '';
      lines.push(`- ${e.label} (${e.uses}×)${caption}${examples}`);
    }
  }

  return {
    messages: profile.messages,
    reactedMessages: profile.reactedMessages,
    baseRate: profile.baseRate,
    emojis,
    text: lines.join('\n'),
    builtAt: now,
  };
}

/**
 * The guide for these channels, straight from the archive. A few spare emojis are requested so the
 * guide stays full after removed server emojis are filtered out.
 */
export function buildGuideFromArchive(channelIds: string[], usableEmojis: EmojiRow[], now: number): ReactionGuide {
  const request = { limit: GUIDE_EMOJIS * 2, samplesPerEmoji: GUIDE_EXAMPLES };
  const profiles = channelIds.map((channelId) => getReactionProfile({ ...request, channelId }));
  return buildReactionGuide(mergeProfiles(profiles), usableEmojis, now);
}

export type GuideCacheOptions = {
  build: () => ReactionGuide;
  now?: () => number;
  /** How long a guide is reused once the archive has enough data. */
  ttlMs?: number;
  /** How long a guide is reused while still learning (the backfill may be importing history right now). */
  learningTtlMs?: number;
};

/**
 * Rebuilt once a day: the profile moves slowly and its queries scan every reacted message. While the
 * archive is still short of the learn-first threshold it is rebuilt hourly instead, so the feature
 * wakes up soon after a history import crosses it rather than up to a day later.
 */
export class ReactionGuideCache {
  private readonly build: () => ReactionGuide;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly learningTtlMs: number;
  private guide: ReactionGuide | undefined;
  private expiresAt = 0;

  constructor(opts: GuideCacheOptions) {
    this.build = opts.build;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    this.learningTtlMs = opts.learningTtlMs ?? 60 * 60 * 1000;
  }

  /** The current guide; `minReacted` decides which TTL a freshly built one gets. */
  get(minReacted: number): ReactionGuide {
    const now = this.now();
    if (this.guide && now < this.expiresAt) return this.guide;
    this.guide = this.build();
    this.expiresAt = now + (this.guide.reactedMessages >= minReacted ? this.ttlMs : this.learningTtlMs);
    return this.guide;
  }

  invalidate(): void {
    this.guide = undefined;
    this.expiresAt = 0;
  }
}
