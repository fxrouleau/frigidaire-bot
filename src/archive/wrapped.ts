// "Wrapped": a stats post for the previous month (on the 1st, ~15:00 Eastern) and the previous year
// (on Jan 1, same time) in WRAPPED_CHANNEL_ID, computed from the archive.
//
// The post is deterministic text; the only model output is one optional roast-y intro line (chat model,
// ZDR-routed, tagged 'wrapped'), and any failure there just drops the line. Each period posts once: a
// watermark row in bot.db is claimed ('posting') before the stats and the intro are computed, switched
// to 'sending' right before the first message goes out, and finalized after, so a restart, a second
// tick or a redeploy never double-posts. A claim abandoned while still 'posting' (the bot restarted
// mid-intro: nothing was sent) is taken over once stale; one abandoned while 'sending' never is, since
// part of the post may be out.
//
// Privacy: the post is public to whoever can read the Wrapped channel, so only channels at least that
// visible count (see makeAudienceAccess); a private channel's messages never surface in the stats, the
// top channel, or the quoted longest message.
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
import { type ArchiveStore, getArchiveStore } from './archiveStore';
import { getActiveArchiveSync } from './backfill';
import { reconcileRelays } from './ingest';
import { type GuildLike, type PermissionedChannel, allowedChannelIds, jumpLink, makeAudienceAccess } from './search';
import { type AuthorCount, type LinkPlatform, type WrappedStats, computeWrappedStats } from './stats';

export type WrappedPeriod = {
  kind: 'month' | 'year';
  /** Watermark key: 'month:2026-08' or 'year:2025'. */
  key: string;
  /** Human label: 'August 2026' or '2025'. */
  label: string;
  startMs: number;
  endMs: number;
  /** When the post is due: the period's end day at 15:00 Eastern. */
  dueAtMs: number;
};

const POST_HOUR_ET = 15;
// A period is still posted when the bot comes back within this long after the due time (it was down on
// the 1st); later than that, the moment has passed and the period is skipped.
const LATE_WINDOW_MS = 3 * 86_400_000;
const MAX_ATTEMPTS = 3;
const INTRO_TIMEOUT_MS = 30_000;
// Far longer than computing the stats and the intro ever takes: a 'posting' claim this old was abandoned.
const STALE_CLAIM_MS = 15 * 60_000;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function monthPeriod(year: number, month: number): WrappedPeriod {
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endMs = easternWallClockToDate(nextYear, nextMonth, 1).getTime();
  return {
    kind: 'month',
    key: `month:${year}-${String(month).padStart(2, '0')}`,
    label: `${MONTH_NAMES[month - 1]} ${year}`,
    startMs: easternWallClockToDate(year, month, 1).getTime(),
    endMs,
    dueAtMs: easternWallClockToDate(nextYear, nextMonth, 1, POST_HOUR_ET).getTime(),
  };
}

export function yearPeriod(year: number): WrappedPeriod {
  return {
    kind: 'year',
    key: `year:${year}`,
    label: String(year),
    startMs: easternWallClockToDate(year, 1, 1).getTime(),
    endMs: easternWallClockToDate(year + 1, 1, 1).getTime(),
    dueAtMs: easternWallClockToDate(year + 1, 1, 1, POST_HOUR_ET).getTime(),
  };
}

/** The periods whose post is due at `now` (monthly first, then yearly on Jan 1). */
export function duePeriods(now: Date): WrappedPeriod[] {
  const et = easternParts(now);
  const previousMonth = et.month === 1 ? monthPeriod(et.year - 1, 12) : monthPeriod(et.year, et.month - 1);
  const candidates = [previousMonth];
  if (et.month === 1) candidates.push(yearPeriod(et.year - 1));
  const t = now.getTime();
  return candidates.filter((p) => t >= p.dueAtMs && t < p.dueAtMs + LATE_WINDOW_MS);
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
  emoji: (emoji: { id: string; name: string; animated: boolean }) => string;
  channel: (id: string) => string;
  coverageNote?: string;
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

/** The Wrapped post. Pure: same stats and options, same text. Lines with nothing to report are left out. */
export function renderWrapped(period: WrappedPeriod, stats: WrappedStats, opts: WrappedRenderOptions): string {
  const lines: string[] = [];
  const title = period.kind === 'month' ? `${period.label}` : `the year ${period.label}`;
  lines.push(`📦 **${escapeMarkdown(opts.botName)} Wrapped — ${title}**`);
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
    const label = period.kind === 'month' ? 'Ramble of the month' : 'Ramble of the year';
    lines.push(
      `📜 ${label}: ${opts.person(stats.longest)} with ${plural(stats.longest.length, 'character')} — "${snippet(stats.longest.content)}" ${jumpLink({ guildId: stats.longest.guildId, channelId: stats.longest.channelId, id: stats.longest.messageId })}`,
    );
  }
  if (stats.botPings.total > 0) {
    const top = stats.botPings.top ? ` (${opts.person(stats.botPings.top)}: ${n(stats.botPings.top.count)})` : '';
    lines.push(
      `🤖 You pinged me ${plural(stats.botPings.total, 'time')}${top}; I answered ${plural(stats.botPings.botReplies, 'time')}`,
    );
  }
  if (opts.coverageNote) lines.push('', `-# ${opts.coverageNote}`);
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
    `${period.kind === 'month' ? 'Month' : 'Year'}: ${period.label}.`,
    `${n(stats.totalMessages)} messages from ${stats.activeMembers} people.`,
  ];
  if (stats.topMembers.length > 0)
    parts.push(`Top talkers: ${stats.topMembers.map((m) => `${nameOf(m)} (${n(m.count)})`).join(', ')}.`);
  if (stats.busiestHour) parts.push(`Peak hour: ${hourLabel(stats.busiestHour.hour)}.`);
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
              'You write the one-line intro of a stats recap for a private Discord server of close friends who roast each other constantly. Be funny and a little mean about the numbers: call someone out by name. Crude is fine. Max 25 words, one line, no hashtags, no emojis, no quotation marks. Output only the line.',
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

// ---------------------------------------------------------------- posting

/** The Wrapped channel as the poster needs it; a discord.js guild text channel fits. */
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

let checkRunning = false;

/** Posts every due, not-yet-posted period. Never throws. */
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
    const store = deps.store();
    reconcileRelays(store, { sinceMs: period.startMs });

    const access = makeAudienceAccess(channel.guild, channel);
    const channelIds = allowedChannelIds(store, access);
    const stats = computeWrappedStats(
      { startMs: period.startMs, endMs: period.endMs, channelIds },
      { botUserId: deps.botUserId, store },
    );
    if (stats.totalMessages === 0) {
      logger.info(`wrapped: nothing archived for ${period.label}; skipping.`);
      finishWrappedPeriod(period.key, 'skipped', deps.now().getTime());
      return;
    }

    const nameOf = (a: Pick<AuthorCount, 'authorId' | 'authorName'>) => currentName(a.authorId) ?? a.authorName;
    const intro = config.archive.wrappedLlmIntro ? await deps.intro(period, stats, nameOf) : undefined;
    const text = renderWrapped(period, stats, {
      botName: deps.botName,
      intro,
      person: (a) => (a.authorId ? `<@${a.authorId}>` : `**${escapeMarkdown(a.authorName)}**`),
      emoji: (e) =>
        channel.guild.emojis.cache.get(e.id) ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : `:${e.name}:`,
      channel: (id) => `<#${id}>`,
      coverageNote: coverageNote(store, period),
    });

    markWrappedSending(period.key, deps.now().getTime());
    for (const chunk of splitMessage(text)) {
      // Mentions render as names but never ping anyone (the intro could also say @everyone).
      const sent = await channel.send({ content: chunk, allowedMentions: { parse: [] } });
      firstId ??= sent.id;
    }
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
