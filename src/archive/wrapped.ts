// "Wrapped": a yearly stats post for the previous year, on Jan 1 from ~15:00 Eastern, in
// WRAPPED_CHANNEL_ID (default: the report channel, so the owner sees it before the group does),
// computed from the archive. There is no monthly post: once a year keeps it an event, not noise.
//
// The post is deterministic text; the only model output is one optional roast-y intro line (chat model,
// ZDR-routed, tagged 'wrapped'), and any failure there just drops the line. Each year posts once: a
// watermark row in bot.db is claimed ('posting') before the stats and the intro are computed, switched
// to 'sending' right before the first message goes out, and finalized after, so a restart, a second
// tick or a redeploy never double-posts. A claim abandoned while still 'posting' (the bot restarted
// mid-intro: nothing was sent) is taken over once stale; one abandoned while 'sending' never is, since
// part of the post may be out.
//
// Preview: `!wrapped` (this year so far) or `!wrapped 2025` (a whole past year) typed in the report
// channel posts the same text there on demand, so the owner can check it long before January. A
// preview never touches the watermark.
//
// Privacy: the post is public to whoever can read the Wrapped channel, so only channels at least that
// visible count (see makeAudienceAccess); a private channel's messages never surface in the stats, the
// top channel, or the quoted messages. A preview counts only channels that are at least as visible as
// BOTH the Wrapped channel and the channel the preview is posted in.
import { type Client, escapeMarkdown } from 'discord.js';
import type OpenAI from 'openai';
import { getMemoryStore } from '../ai/memory';
import { getOpenRouterClient } from '../ai/openRouterClient';
import { featureRequestOptions } from '../ai/usage';
import { easternParts, easternWallClockToDate } from '../ai/utils';
import { config } from '../config';
import { logger } from '../logger';
import { getBotDb } from '../storage/botDb';
import { splitMessage } from '../utils';
import { type ArchiveStore, type ArchivedChannel, getArchiveStore } from './archiveStore';
import { getActiveArchiveSync } from './backfill';
import { isThreadType, reconcileRelays } from './ingest';
import { type GuildLike, type PermissionedChannel, allowedChannelIds, jumpLink, makeAudienceAccess } from './search';
import {
  type AuthorCount,
  type LinkPlatform,
  type MostReactedMessage,
  type WrappedStats,
  computeWrappedStats,
} from './stats';

export type WrappedPeriod = {
  /** Watermark key: 'year:2025'. A year-so-far preview has 'preview:2026', which is never stored. */
  key: string;
  /** Human label: '2025'. */
  label: string;
  year: number;
  startMs: number;
  endMs: number;
  /** When the post is due: Jan 1 of the following year at 15:00 Eastern. */
  dueAtMs: number;
  /** A preview of a year that isn't over: the numbers run up to `endMs` (the moment it was asked for). */
  partial?: boolean;
};

const POST_HOUR_ET = 15;
// A year is still posted when the bot comes back within this long after the due time (it was down on
// Jan 1); later than that, the moment has passed and the year is skipped.
const LATE_WINDOW_MS = 3 * 86_400_000;
const MAX_ATTEMPTS = 3;
const INTRO_TIMEOUT_MS = 30_000;
// Far longer than computing the stats and the intro ever takes: a 'posting' claim this old was abandoned.
const STALE_CLAIM_MS = 15 * 60_000;
// Discord's launch year: nothing older can be in the archive.
const FIRST_PREVIEW_YEAR = 2015;
// The preview's "counted channels" footnote names at most this many.
const MAX_LISTED_CHANNELS = 15;

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function yearPeriod(year: number): WrappedPeriod {
  return {
    key: `year:${year}`,
    label: String(year),
    year,
    startMs: easternWallClockToDate(year, 1, 1).getTime(),
    endMs: easternWallClockToDate(year + 1, 1, 1).getTime(),
    dueAtMs: easternWallClockToDate(year + 1, 1, 1, POST_HOUR_ET).getTime(),
  };
}

/** The current Eastern year from Jan 1 up to `now`, for a preview. */
export function yearToDatePeriod(now: Date): WrappedPeriod {
  const year = easternParts(now).year;
  return { ...yearPeriod(year), key: `preview:${year}`, endMs: now.getTime(), partial: true };
}

/** The year whose post is due at `now` (Jan 1 from 15:00 ET, for LATE_WINDOW_MS), or nothing. */
export function duePeriods(now: Date): WrappedPeriod[] {
  const previousYear = yearPeriod(easternParts(now).year - 1);
  const t = now.getTime();
  return t >= previousYear.dueAtMs && t < previousYear.dueAtMs + LATE_WINDOW_MS ? [previousYear] : [];
}

// ---------------------------------------------------------------- watermark (bot.db)

const WATERMARK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS wrapped_posts (
    period_key TEXT    PRIMARY KEY,
    status     TEXT    NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    message_id TEXT,
    updated_at INTEGER NOT NULL
  );
`;

type WatermarkStatus = 'posting' | 'sending' | 'posted' | 'skipped' | 'retry' | 'failed';

export type WrappedWatermark = {
  status: WatermarkStatus;
  attempts: number;
  messageId: string | null;
  updatedAt: number;
};

function watermarkDb() {
  const db = getBotDb();
  db.ensureSchema('wrapped_posts', WATERMARK_SCHEMA);
  return db;
}

export function getWrappedStatus(key: string): WrappedWatermark | undefined {
  const row = watermarkDb()
    .stmt('SELECT status, attempts, message_id, updated_at FROM wrapped_posts WHERE period_key = ?')
    .get(key) as
    | { status: WatermarkStatus; attempts: number; message_id: string | null; updated_at: number }
    | undefined;
  return row && { status: row.status, attempts: row.attempts, messageId: row.message_id, updatedAt: row.updated_at };
}

/**
 * Claims a period for posting. False when it is posted, skipped, failed for good, being sent, or
 * claimed by a run that is still within STALE_CLAIM_MS.
 */
export function claimWrappedPeriod(key: string, now: number): boolean {
  const db = watermarkDb();
  return db.transaction(() => {
    const row = getWrappedStatus(key);
    if (!row) {
      db.stmt("INSERT INTO wrapped_posts (period_key, status, attempts, updated_at) VALUES (?, 'posting', 1, ?)").run(
        key,
        now,
      );
      return true;
    }
    const abandoned = row.status === 'posting' && now - row.updatedAt >= STALE_CLAIM_MS;
    if (row.status !== 'retry' && !abandoned) return false;
    db.stmt(
      "UPDATE wrapped_posts SET status = 'posting', attempts = attempts + 1, updated_at = ? WHERE period_key = ?",
    ).run(now, key);
    return true;
  });
}

/** Marks the point of no return: from here on a crash must not lead to a second post. */
export function markWrappedSending(key: string, now: number): void {
  watermarkDb().stmt("UPDATE wrapped_posts SET status = 'sending', updated_at = ? WHERE period_key = ?").run(now, key);
}

export function finishWrappedPeriod(
  key: string,
  status: Exclude<WatermarkStatus, 'posting' | 'sending'>,
  now: number,
  messageId?: string,
): void {
  const db = watermarkDb();
  const row = getWrappedStatus(key);
  const finalStatus = status === 'retry' && (row?.attempts ?? 0) >= MAX_ATTEMPTS ? 'failed' : status;
  db.stmt('UPDATE wrapped_posts SET status = ?, message_id = ?, updated_at = ? WHERE period_key = ?').run(
    finalStatus,
    messageId ?? null,
    now,
    key,
  );
}

// ---------------------------------------------------------------- rendering

const PLATFORM_LABELS: Record<LinkPlatform, string> = {
  twitter: 'Twitter/X',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  reddit: 'Reddit',
  twitch: 'Twitch',
  spotify: 'Spotify',
  gifs: 'GIF sites',
  other: 'other',
};

export type WrappedRenderOptions = {
  botName: string;
  intro?: string;
  /** How a person is shown: a mention (rendered without pinging) or a bold name. */
  person: (author: Pick<AuthorCount, 'authorId' | 'authorName'>) => string;
  /** How a custom emoji is shown (unicode emojis are shown as themselves). */
  emoji: (emoji: { id: string; name: string; animated: boolean }) => string;
  channel: (id: string) => string;
  /** A small-text line above the title (the preview banner). */
  banner?: string;
  /** Small-text lines under the post (import still running, what a preview counted). */
  footnotes?: string[];
};

function n(value: number): string {
  return value.toLocaleString('en-US');
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${n(count)} ${count === 1 ? one : many}`;
}

function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? 'AM' : 'PM'}`;
}

function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${MONTH_SHORT[m - 1]} ${d}`;
}

/** Markdown-escapes text but leaves Discord tokens (<@id>, <:emoji:id>, <#id>) intact. */
function escapeOutsideTokens(text: string): string {
  return text
    .split(/(<[^<>\s]+>)/g)
    .map((part, i) => (i % 2 === 1 ? part : escapeMarkdown(part)))
    .join('');
}

function snippet(content: string, max = 180): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1).replace(/<[^>]*$/, '')}…` : flat;
  return escapeOutsideTokens(cut);
}

/** What the most reacted message said, or what it carried when it has no text (a meme is the usual winner). */
function mostReactedPreview(message: MostReactedMessage): string {
  if (message.content.trim()) return `"${snippet(message.content, 140)}"`;
  if (message.attachmentName) return `[${escapeMarkdown(message.attachmentName)}]`;
  if (message.linkTitle) return `[link: ${snippet(message.linkTitle, 100)}]`;
  return '';
}

/** The Wrapped post. Pure: same stats and options, same text. Lines with nothing to report are left out. */
export function renderWrapped(period: WrappedPeriod, stats: WrappedStats, opts: WrappedRenderOptions): string {
  const lines: string[] = [];
  if (opts.banner) lines.push(`-# ${opts.banner}`);
  lines.push(`📦 **${escapeMarkdown(opts.botName)} Wrapped — ${period.label}${period.partial ? ' (so far)' : ''}**`);
  if (opts.intro) lines.push(`*${escapeMarkdown(opts.intro)}*`);
  lines.push('');

  lines.push(
    `💬 **${n(stats.totalMessages)}** messages from **${n(stats.activeMembers)}** ${stats.activeMembers === 1 ? 'person' : 'people'}`,
  );
  if (stats.topMembers.length > 0) {
    lines.push('🏆 **Top yappers**');
    stats.topMembers.forEach((m, i) => lines.push(`${i + 1}. ${opts.person(m)} — ${n(m.count)}`));
  }

  const when: string[] = [];
  if (stats.busiestDay)
    when.push(`busiest day **${dayLabel(stats.busiestDay.date)}** (${plural(stats.busiestDay.count, 'message')})`);
  if (stats.busiestHour) {
    when.push(`peak hour **${hourLabel(stats.busiestHour.hour)}–${hourLabel((stats.busiestHour.hour + 1) % 24)}** ET`);
  }
  if (when.length > 0) {
    const joined = when.join(' · ');
    lines.push(`📅 ${joined.charAt(0).toUpperCase()}${joined.slice(1)}`);
  }
  if (stats.topChannel)
    lines.push(
      `📍 Top channel: ${opts.channel(stats.topChannel.channelId)} (${plural(stats.topChannel.count, 'message')})`,
    );
  if (stats.topEmojis.length > 0) {
    lines.push(`😂 Top emojis: ${stats.topEmojis.map((e) => `${opts.emoji(e)} ×${n(e.count)}`).join(' · ')}`);
  }
  if (stats.mostReacted) {
    const top = stats.mostReacted;
    const emojis = top.reactions
      .slice(0, 3)
      .map((r) => `${r.id ? opts.emoji({ id: r.id, name: r.name, animated: r.animated }) : r.name} ×${n(r.count)}`)
      .join(' ');
    const preview = mostReactedPreview(top);
    lines.push(
      `🔥 Most reacted message of the year: ${opts.person(top)} — ${plural(top.total, 'reaction')}${emojis ? ` (${emojis})` : ''}${preview ? ` — ${preview}` : ''} ${jumpLink({ guildId: top.guildId, channelId: top.channelId, id: top.messageId })}`,
    );
  }
  if (stats.links.length > 0) {
    lines.push(`🔗 Links: ${stats.links.map((l) => `${PLATFORM_LABELS[l.platform]} ${n(l.count)}`).join(' · ')}`);
  }
  if (stats.voice.total > 0 && stats.voice.top) {
    lines.push(
      `🎙️ Voice messages: ${n(stats.voice.total)} — most from ${opts.person(stats.voice.top)} (${n(stats.voice.top.count)})`,
    );
  }
  if (stats.regrets.total > 0 && stats.regrets.top.length > 0) {
    const [first, ...rest] = stats.regrets.top;
    const others =
      rest.length > 0 ? `; runners-up ${rest.map((r) => `${opts.person(r)} (${n(r.count)})`).join(', ')}` : '';
    lines.push(
      `🫣 Most regretted: ${opts.person(first)} — ${plural(first.count, 'message')} deleted and put right back${others}`,
    );
  }
  const fixes: string[] = [];
  if (stats.edits.total > 0 && stats.edits.top) {
    fixes.push(`✏️ ${plural(stats.edits.total, 'edit')} (${opts.person(stats.edits.top)}: ${n(stats.edits.top.count)})`);
  }
  if (stats.deletions.total > 0 && stats.deletions.top) {
    fixes.push(
      `🗑️ ${plural(stats.deletions.total, 'deletion')} (${opts.person(stats.deletions.top)}: ${n(stats.deletions.top.count)})`,
    );
  }
  if (fixes.length > 0) lines.push(fixes.join(' · '));
  if (stats.longest) {
    lines.push(
      `📜 Ramble of the year: ${opts.person(stats.longest)} with ${plural(stats.longest.length, 'character')} — "${snippet(stats.longest.content)}" ${jumpLink({ guildId: stats.longest.guildId, channelId: stats.longest.channelId, id: stats.longest.messageId })}`,
    );
  }
  if (stats.botPings.total > 0) {
    const top = stats.botPings.top ? ` (${opts.person(stats.botPings.top)}: ${n(stats.botPings.top.count)})` : '';
    lines.push(
      `🤖 You pinged me ${plural(stats.botPings.total, 'time')}${top}; I answered ${plural(stats.botPings.botReplies, 'time')}`,
    );
  }
  const footnotes = opts.footnotes ?? [];
  if (footnotes.length > 0) lines.push('', ...footnotes.map((note) => `-# ${note}`));
  return lines.join('\n');
}

// ---------------------------------------------------------------- intro line

/** A plain-text digest of the stats for the intro prompt: names and numbers only, no message text. */
function statsDigest(
  period: WrappedPeriod,
  stats: WrappedStats,
  nameOf: (a: Pick<AuthorCount, 'authorId' | 'authorName'>) => string,
): string {
  const parts = [
    `Year: ${period.label}${period.partial ? ' (so far)' : ''}.`,
    `${n(stats.totalMessages)} messages from ${stats.activeMembers} people.`,
  ];
  if (stats.topMembers.length > 0)
    parts.push(`Top talkers: ${stats.topMembers.map((m) => `${nameOf(m)} (${n(m.count)})`).join(', ')}.`);
  if (stats.busiestHour) parts.push(`Peak hour: ${hourLabel(stats.busiestHour.hour)}.`);
  if (stats.mostReacted)
    parts.push(`Most reacted message: ${nameOf(stats.mostReacted)} (${n(stats.mostReacted.total)} reactions).`);
  if (stats.regrets.top[0])
    parts.push(`Most deleted-and-reposted: ${nameOf(stats.regrets.top[0])} (${stats.regrets.top[0].count}).`);
  if (stats.longest) parts.push(`Longest message: ${nameOf(stats.longest)}, ${n(stats.longest.length)} characters.`);
  if (stats.botPings.top)
    parts.push(`Pinged the bot most: ${nameOf(stats.botPings.top)} (${stats.botPings.top.count}).`);
  if (stats.edits.top) parts.push(`Most edits: ${nameOf(stats.edits.top)}.`);
  return parts.join(' ');
}

/** Removes quotes, labels and extra lines a model wraps around a one-liner. Undefined when nothing usable is left. */
export function cleanIntro(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const firstLine = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return undefined;
  const cleaned = firstLine
    .replace(/^(intro|line)\s*:\s*/i, '')
    .replace(/^["“'*_]+|["”'*_]+$/g, '')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > 280 ? `${cleaned.slice(0, 279)}…` : cleaned;
}

/** One roast-y intro line from the chat model, or undefined (no key, error, timeout, empty answer). */
export async function generateWrappedIntro(
  period: WrappedPeriod,
  stats: WrappedStats,
  nameOf: (a: Pick<AuthorCount, 'authorId' | 'authorName'>) => string,
  deps: { client?: OpenAI; model?: string } = {},
): Promise<string | undefined> {
  const client = deps.client ?? getOpenRouterClient();
  if (!client) return undefined;
  const model = deps.model ?? config.models.chat;
  try {
    const response = await client.chat.completions.create(
      {
        model,
        max_tokens: 200,
        temperature: 0.9,
        // @ts-expect-error OpenRouter-specific field
        provider: { zdr: true },
        messages: [
          {
            role: 'system',
            content:
              'You write the one-line intro of a year-in-review stats recap for a private Discord server of close friends who roast each other constantly. Be funny and a little mean about the numbers: call someone out by name. Crude is fine. Max 25 words, one line, no hashtags, no emojis, no quotation marks. Output only the line.',
          },
          { role: 'user', content: statsDigest(period, stats, nameOf) },
        ],
      },
      { ...featureRequestOptions('wrapped'), timeout: INTRO_TIMEOUT_MS },
    );
    const intro = cleanIntro(response.choices?.[0]?.message?.content);
    if (!intro) logger.warn(`wrapped: ${model} returned no usable intro line.`);
    return intro;
  } catch (error) {
    logger.warn(`wrapped: intro line from ${model} failed; posting without it:`, error);
    return undefined;
  }
}

// ---------------------------------------------------------------- composing

/** A channel Wrapped posts to (the Wrapped channel, or where a preview was asked for); a discord.js guild text channel fits. */
export type WrappedChannel = PermissionedChannel & {
  guild: GuildLike & {
    roles: { cache: { values(): Iterable<unknown> } };
    emojis: { cache: { get(id: string): unknown } };
  };
  send(options: { content: string; allowedMentions: { parse: never[] } }): Promise<{ id: string }>;
};

export type WrappedDeps = {
  now: () => Date;
  store: () => ArchiveStore;
  /** The Wrapped channel (WRAPPED_CHANNEL_ID, else REPORT_CHANNEL_ID). */
  channelId: () => string | undefined;
  fetchChannel: (id: string) => Promise<WrappedChannel | undefined>;
  botUserId?: string;
  botName: string;
  intro: (
    period: WrappedPeriod,
    stats: WrappedStats,
    nameOf: (a: Pick<AuthorCount, 'authorId' | 'authorName'>) => string,
  ) => Promise<string | undefined>;
  /** True while the startup gap fill runs: stats would miss what was posted during downtime. */
  syncBusy: () => boolean;
};

/** The post's text for `period` over `channelIds`; undefined when nothing was said there. */
async function composeWrapped(
  period: WrappedPeriod,
  channelIds: string[],
  guild: WrappedChannel['guild'],
  deps: WrappedDeps,
  extras: { banner?: string; footnotes?: string[] } = {},
): Promise<string | undefined> {
  const store = deps.store();
  reconcileRelays(store, { sinceMs: period.startMs });
  const stats = computeWrappedStats(
    { startMs: period.startMs, endMs: period.endMs, channelIds },
    { botUserId: deps.botUserId, store },
  );
  if (stats.totalMessages === 0) return undefined;

  const nameOf = (a: Pick<AuthorCount, 'authorId' | 'authorName'>) => currentName(a.authorId) ?? a.authorName;
  const intro = config.archive.wrappedLlmIntro ? await deps.intro(period, stats, nameOf) : undefined;
  const coverage = coverageNote(store, period);
  return renderWrapped(period, stats, {
    botName: deps.botName,
    intro,
    person: (a) => (a.authorId ? `<@${a.authorId}>` : `**${escapeMarkdown(a.authorName)}**`),
    emoji: (e) => (guild.emojis.cache.get(e.id) ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : `:${e.name}:`),
    channel: (id) => `<#${id}>`,
    banner: extras.banner,
    footnotes: [...(coverage ? [coverage] : []), ...(extras.footnotes ?? [])],
  });
}

async function sendChunks(channel: WrappedChannel, text: string, onSent?: (id: string) => void): Promise<void> {
  for (const chunk of splitMessage(text)) {
    // Mentions render as names but never ping anyone (the intro could also say @everyone).
    const sent = await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    onSent?.(sent.id);
  }
}

// ---------------------------------------------------------------- the yearly post

let checkRunning = false;

/** Posts the due, not-yet-posted year, if any. Never throws. */
export async function runWrappedCheck(deps: WrappedDeps): Promise<void> {
  if (checkRunning || deps.syncBusy()) return;
  checkRunning = true;
  try {
    for (const period of duePeriods(deps.now())) {
      await postPeriod(period, deps);
    }
  } catch (error) {
    logger.warn('wrapped: check failed:', error);
  } finally {
    checkRunning = false;
  }
}

async function postPeriod(period: WrappedPeriod, deps: WrappedDeps): Promise<void> {
  const channelId = deps.channelId();
  if (!channelId) return;
  if (!claimWrappedPeriod(period.key, deps.now().getTime())) return;

  let firstId: string | undefined;
  try {
    const channel = await deps.fetchChannel(channelId);
    if (!channel) {
      logger.warn(`wrapped: channel ${channelId} is missing or not a server text channel; will retry.`);
      finishWrappedPeriod(period.key, 'retry', deps.now().getTime());
      return;
    }
    const channelIds = allowedChannelIds(deps.store(), makeAudienceAccess(channel.guild, channel));
    const text = await composeWrapped(period, channelIds, channel.guild, deps);
    if (!text) {
      // WARN: a whole year with nothing to show is almost always a configuration problem (the Wrapped
      // channel's audience can read no archived channel), and the year is not retried.
      logger.warn(
        `wrapped: nothing archived for ${period.label} in the ${channelIds.length} channel(s) as public as ${channelId}; skipping.`,
      );
      finishWrappedPeriod(period.key, 'skipped', deps.now().getTime());
      return;
    }

    markWrappedSending(period.key, deps.now().getTime());
    await sendChunks(channel, text, (id) => {
      firstId ??= id;
    });
    finishWrappedPeriod(period.key, 'posted', deps.now().getTime(), firstId);
    logger.info(`wrapped: posted ${period.label} to ${channelId}.`);
  } catch (error) {
    if (firstId) {
      // Part of the post is out: posting it again would duplicate that part.
      logger.warn(`wrapped: ${period.label} was only partly posted; not retrying:`, error);
      finishWrappedPeriod(period.key, 'posted', deps.now().getTime(), firstId);
      return;
    }
    logger.warn(`wrapped: posting ${period.label} failed; will retry:`, error);
    finishWrappedPeriod(period.key, 'retry', deps.now().getTime());
  }
}

// ---------------------------------------------------------------- the preview

export type WrappedPreviewRequest = {
  /** The channel the preview was asked for in (the report channel); the preview is posted there. */
  channelId: string;
  /** A whole past year; absent ⇒ the current year so far. */
  year?: number;
};

/** `!wrapped` (this year so far) or `!wrapped 2025` (that year). Undefined for any other text. */
export function parseWrappedPreviewCommand(content: string): Omit<WrappedPreviewRequest, 'channelId'> | undefined {
  const match = content.trim().match(/^!wrapped(?:\s+(\d{4}))?$/i);
  if (!match) return undefined;
  return match[1] ? { year: Number(match[1]) } : {};
}

let previewRunning = false;

/**
 * Posts a preview of the Wrapped post into the channel it was asked for in. Everything is the real
 * pipeline (stats, audience filter, intro line, rendering) except the watermark, which is never read
 * or written. Answers every outcome in that channel; never throws.
 */
export async function runWrappedPreview(request: WrappedPreviewRequest, deps: WrappedDeps): Promise<void> {
  if (previewRunning) {
    logger.info('wrapped: a preview is already being built; ignoring the second request.');
    return;
  }
  previewRunning = true;
  let channel: WrappedChannel | undefined;
  try {
    channel = await deps.fetchChannel(request.channelId);
    if (!channel) {
      logger.warn(`wrapped: preview channel ${request.channelId} is missing or not a server text channel.`);
      return;
    }
    await preview(request, channel, deps);
  } catch (error) {
    logger.warn('wrapped: preview failed:', error);
    await channel
      ?.send({ content: "-# couldn't build the Wrapped preview; the logs say why.", allowedMentions: { parse: [] } })
      .catch(() => undefined);
  } finally {
    previewRunning = false;
  }
}

async function preview(request: WrappedPreviewRequest, here: WrappedChannel, deps: WrappedDeps): Promise<void> {
  const say = (text: string) => sendChunks(here, text);
  const now = deps.now();
  const currentYear = easternParts(now).year;
  if (request.year !== undefined && (request.year > currentYear || request.year < FIRST_PREVIEW_YEAR)) {
    await say(`-# no Wrapped for ${request.year}: pick a year from ${FIRST_PREVIEW_YEAR} to ${currentYear}.`);
    return;
  }
  if (deps.syncBusy()) {
    await say('-# still catching up on messages from while I was down; try `!wrapped` again in a minute.');
    return;
  }
  const period =
    request.year === undefined || request.year === currentYear ? yearToDatePeriod(now) : yearPeriod(request.year);

  // The real post's audience: the Wrapped channel (defaulting to right here when none is configured).
  const wrappedId = deps.channelId() ?? here.id;
  const wrapped = wrappedId === here.id ? here : await deps.fetchChannel(wrappedId).catch(() => undefined);
  const notes: string[] = [];
  const hereAccess = makeAudienceAccess(here.guild, here);
  let access = hereAccess;
  if (wrapped) {
    const wrappedAccess = makeAudienceAccess(wrapped.guild, wrapped);
    access = (c: ArchivedChannel) => hereAccess(c) && wrappedAccess(c);
  } else {
    notes.push(`⚠️ can't see the Wrapped channel <#${wrappedId}>: the real post would fail. Counting for this channel.`);
  }

  const store = deps.store();
  const channelIds = allowedChannelIds(store, access);
  notes.push(countedChannelsNote(store, channelIds));
  if (!config.archive.wrappedEnabled) notes.push('WRAPPED_ENABLED=false: the yearly post itself is off.');

  const banner = `👀 preview, not the real post: that one goes to <#${wrappedId}> on Jan 1 at 3 PM ET`;
  const text = await composeWrapped(period, channelIds, here.guild, deps, { banner, footnotes: notes });
  if (!text) {
    await say(
      [
        `-# nothing archived for ${period.label} in the channels this post would count.`,
        ...notes.map((l) => `-# ${l}`),
      ].join('\n'),
    );
    return;
  }
  await say(text);
  logger.info(`wrapped: posted a preview of ${period.label} to ${here.id}.`);
}

/** "counted 3 channels: #a, #b, #c (+12 threads)" — so a wrong audience shows before January does. */
function countedChannelsNote(store: ArchiveStore, channelIds: string[]): string {
  if (channelIds.length === 0) return 'counted no channels: no archived channel is as visible as this post.';
  const allowed = new Set(channelIds);
  const channels = store.listChannels().filter((c) => allowed.has(c.id));
  const top = channels.filter((c) => !isThreadType(c.type));
  const threads = channels.length - top.length;
  const named = top.slice(0, MAX_LISTED_CHANNELS).map((c) => `<#${c.id}>`);
  const more = top.length > MAX_LISTED_CHANNELS ? ` and ${top.length - MAX_LISTED_CHANNELS} more` : '';
  const threadNote = threads > 0 ? ` (+${plural(threads, 'thread')})` : '';
  return `counted ${plural(top.length, 'channel')}: ${named.join(', ')}${more}${threadNote}`;
}

// ---------------------------------------------------------------- helpers

function currentName(authorId: string | null): string | undefined {
  if (!authorId) return undefined;
  try {
    return getMemoryStore().getIdentityById(authorId)?.display_name;
  } catch {
    return undefined;
  }
}

/** A footnote when a configured history import hasn't reached the start of the period yet. */
function coverageNote(store: ArchiveStore, period: WrappedPeriod): string | undefined {
  if (!config.archive.backfillEnabled) return undefined;
  const incomplete = config.archive.backfillChannels.some((id) => {
    if (store.getBackfillState(id)?.done) return false;
    const oldest = store.oldestMessage(id);
    return !oldest || oldest.createdAt > period.startMs;
  });
  return incomplete ? 'Still importing older history, so these numbers may run a little low.' : undefined;
}

export function discordWrappedDeps(client: Client<true>): WrappedDeps {
  return {
    now: () => new Date(),
    store: getArchiveStore,
    channelId: () => config.archive.wrappedChannelId,
    fetchChannel: async (id) => {
      const channel = await client.channels.fetch(id);
      if (!channel || channel.isDMBased() || !channel.isTextBased() || !('guild' in channel) || !('send' in channel)) {
        return undefined;
      }
      if (typeof (channel as { permissionsFor?: unknown }).permissionsFor !== 'function') return undefined;
      return channel as unknown as WrappedChannel;
    },
    botUserId: client.user.id,
    botName: client.user.displayName || client.user.username,
    intro: (period, stats, nameOf) => generateWrappedIntro(period, stats, nameOf),
    syncBusy: () => getActiveArchiveSync()?.status().phase === 'gap_fill',
  };
}
