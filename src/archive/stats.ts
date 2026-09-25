// Aggregate statistics over the archive for a time range — what Wrapped is made of, and a stable query
// surface for any other feature that needs "who talked how much".
//
// "Member messages" are source human + relay (a link-fixed or regret-reposted message counts once, as
// its real author), never the bot's own, and never deleted ones: a link-fixed original is deleted by
// the bot and its relay copy already counts.
import { easternParts } from '../ai/utils';
import { config } from '../config';
import { type ArchiveStore, VOICE_MESSAGE_FLAG, getArchiveStore } from './archiveStore';

export type StatsScope = {
  startMs: number;
  endMs: number;
  /** Only these channels (by the message's own channel id). Undefined ⇒ every channel. */
  channelIds?: string[];
};

export type AuthorCount = { authorId: string | null; authorName: string; count: number };

export type LinkPlatform =
  | 'twitter'
  | 'instagram'
  | 'tiktok'
  | 'youtube'
  | 'reddit'
  | 'twitch'
  | 'spotify'
  | 'gifs'
  | 'other';

export type WrappedStats = {
  totalMessages: number;
  activeMembers: number;
  topMembers: AuthorCount[];
  /** Eastern calendar day with the most member messages. */
  busiestDay?: { date: string; count: number };
  /** Eastern hour of day (0-23) with the most member messages over the whole range. */
  busiestHour?: { hour: number; count: number };
  topChannel?: { channelId: string; count: number };
  topEmojis: { id: string; name: string; animated: boolean; count: number }[];
  links: { platform: LinkPlatform; count: number }[];
  voice: { total: number; top?: AuthorCount };
  regrets: { total: number; top: AuthorCount[] };
  edits: { total: number; top?: AuthorCount };
  deletions: { total: number; top?: AuthorCount };
  longest?: {
    authorId: string | null;
    authorName: string;
    length: number;
    content: string;
    messageId: string;
    channelId: string;
    guildId: string | null;
  };
  botPings: { total: number; top?: AuthorCount; botReplies: number };
};

const MEMBER = "source IN ('human', 'relay')";
const HOUR_MS = 3_600_000;
// A link-fix relay posted by the bot between a message's creation and its deletion (and within this
// long of the original) means the bot replaced the message, not that its author deleted it.
const BOT_REPLACEMENT_WINDOW_MS = 120_000;
const DELETE_CLOCK_SLACK_MS = 2000;

/** Host → platform. Fixer domains count as their platform (a link-fixed tweet is still a tweet). */
function platformDomains(): Record<Exclude<LinkPlatform, 'other'>, string[]> {
  return {
    twitter: [
      'twitter.com',
      'x.com',
      'fxtwitter.com',
      'vxtwitter.com',
      'fixvx.com',
      'fixupx.com',
      'twittpr.com',
      ...config.links.twitterFixers,
    ],
    instagram: ['instagram.com', 'instagr.am', 'ddinstagram.com', ...config.links.instagramFixers],
    tiktok: ['tiktok.com', 'vxtiktok.com', ...config.links.tiktokFixers],
    youtube: ['youtube.com', 'youtu.be'],
    reddit: ['reddit.com', 'redd.it', 'rxddit.com', 'vxreddit.com'],
    twitch: ['twitch.tv'],
    spotify: ['spotify.com', 'spotify.link'],
    gifs: ['tenor.com', 'giphy.com'],
  };
}

// Links into Discord itself (jump links, CDN attachments) are not "links shared".
const IGNORED_HOSTS = ['discord.com', 'discordapp.com', 'discordapp.net', 'discord.gg'];

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** The platform of a URL, undefined for links that don't count (Discord's own). */
export function classifyLink(url: string, domains = platformDomains()): LinkPlatform | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (IGNORED_HOSTS.some((d) => hostMatches(host, d))) return undefined;
  for (const [platform, list] of Object.entries(domains) as [Exclude<LinkPlatform, 'other'>, string[]][]) {
    if (list.some((d) => hostMatches(host, d.toLowerCase()))) return platform;
  }
  return 'other';
}

const URL_PATTERN = /https?:\/\/[^\s<>()]+/g;
const CUSTOM_EMOJI = /<(a?):(\w+):(\d+)>/g;

type ScopeSql = { where: string; params: Record<string, string | number> };

function scopeSql(scope: StatsScope, alias = ''): ScopeSql {
  const p = alias ? `${alias}.` : '';
  const params: Record<string, string | number> = { startMs: scope.startMs, endMs: scope.endMs };
  let where = `${p}created_at >= @startMs AND ${p}created_at < @endMs`;
  if (scope.channelIds) {
    params.channelIds = JSON.stringify(scope.channelIds);
    where += ` AND ${p}channel_id IN (SELECT value FROM json_each(@channelIds))`;
  }
  return { where, params };
}

type AuthorRow = { author_id: string | null; author_name: string; n: number };

function toAuthorCount(row: AuthorRow): AuthorCount {
  return { authorId: row.author_id, authorName: row.author_name, count: row.n };
}

/** Per-author counts for rows matching `condition`, most first (ties by name). */
function countByAuthor(
  store: ArchiveStore,
  scope: StatsScope,
  condition: string,
  limit: number,
  opts: { sum?: string; params?: Record<string, string | number> } = {},
): AuthorRow[] {
  const s = scopeSql(scope);
  return store.db
    .prepare(
      `SELECT author_id, MAX(author_name) AS author_name, ${opts.sum ?? 'COUNT(*)'} AS n FROM messages
       WHERE ${s.where} AND ${condition}
       GROUP BY COALESCE(author_id, 'name:' || author_name)
       HAVING n > 0
       ORDER BY n DESC, author_name ASC LIMIT @limit`,
    )
    .all({ ...s.params, ...opts.params, limit }) as AuthorRow[];
}

function total(rows: AuthorRow[]): number {
  return rows.reduce((sum, r) => sum + r.n, 0);
}

/** Member message count per author in a range, most active first. */
export function messageCountsByAuthor(
  scope: StatsScope,
  store: ArchiveStore = getArchiveStore(),
  limit = 50,
): AuthorCount[] {
  return countByAuthor(store, scope, `${MEMBER} AND deleted_at IS NULL`, limit).map(toAuthorCount);
}

/** Everything Wrapped shows, for one range. `botUserId` enables the bot-ping stats. */
export function computeWrappedStats(
  scope: StatsScope,
  opts: { botUserId?: string; store?: ArchiveStore } = {},
): WrappedStats {
  const store = opts.store ?? getArchiveStore();
  const s = scopeSql(scope);
  const live = `${MEMBER} AND deleted_at IS NULL`;

  const totals = store.db
    .prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT COALESCE(author_id, 'name:' || author_name)) AS people
       FROM messages WHERE ${s.where} AND ${live}`,
    )
    .get(s.params) as { n: number; people: number };

  const topMembers = countByAuthor(store, scope, live, 5).map(toAuthorCount);

  // Busiest day/hour: bucket by UTC hour in SQL, then map buckets to Eastern time. Eastern offsets are
  // whole hours, so every UTC hour bucket falls inside exactly one Eastern hour.
  const buckets = store.db
    .prepare(`SELECT created_at / ${HOUR_MS} AS h, COUNT(*) AS n FROM messages WHERE ${s.where} AND ${live} GROUP BY h`)
    .all(s.params) as { h: number; n: number }[];
  const byDay = new Map<string, number>();
  const byHour = new Map<number, number>();
  for (const bucket of buckets) {
    const et = easternParts(new Date(bucket.h * HOUR_MS));
    const day = `${et.year}-${String(et.month).padStart(2, '0')}-${String(et.day).padStart(2, '0')}`;
    byDay.set(day, (byDay.get(day) ?? 0) + bucket.n);
    byHour.set(et.hour, (byHour.get(et.hour) ?? 0) + bucket.n);
  }
  const busiestDay = [...byDay.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const busiestHour = [...byHour.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];

  const topChannel = store.db
    .prepare(
      `SELECT COALESCE(parent_channel_id, channel_id) AS channel_id, COUNT(*) AS n FROM messages
       WHERE ${s.where} AND ${live} GROUP BY 1 ORDER BY n DESC, channel_id ASC LIMIT 1`,
    )
    .get(s.params) as { channel_id: string; n: number } | undefined;

  // Emojis and links need the text; the LIKE prefilters keep the scan to messages that can match.
  const emojiCounts = new Map<string, { id: string; name: string; animated: boolean; count: number }>();
  const emojiRows = store.db
    .prepare(`SELECT content FROM messages WHERE ${s.where} AND ${live} AND content LIKE '%<%:%:%>%'`)
    .all(s.params) as { content: string }[];
  for (const { content } of emojiRows) {
    for (const match of content.matchAll(CUSTOM_EMOJI)) {
      const id = match[3];
      const entry = emojiCounts.get(id) ?? { id, name: match[2], animated: match[1] === 'a', count: 0 };
      entry.count++;
      emojiCounts.set(id, entry);
    }
  }
  const topEmojis = [...emojiCounts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 5);

  const domains = platformDomains();
  const linkCounts = new Map<LinkPlatform, number>();
  const linkRows = store.db
    .prepare(`SELECT content FROM messages WHERE ${s.where} AND ${live} AND content LIKE '%http%://%'`)
    .all(s.params) as { content: string }[];
  for (const { content } of linkRows) {
    for (const match of content.matchAll(URL_PATTERN)) {
      const platform = classifyLink(match[0], domains);
      if (platform) linkCounts.set(platform, (linkCounts.get(platform) ?? 0) + 1);
    }
  }
  const links = [...linkCounts.entries()]
    .map(([platform, count]) => ({ platform, count }))
    .sort((a, b) => (a.platform === 'other' ? 1 : 0) - (b.platform === 'other' ? 1 : 0) || b.count - a.count);

  const voiceRows = countByAuthor(store, scope, `${live} AND (flags & ${VOICE_MESSAGE_FLAG}) != 0`, 1000);
  const regretRows = countByAuthor(
    store,
    scope,
    "source = 'relay' AND relay_kind = 'regret' AND deleted_at IS NULL",
    1000,
  );
  const editRows = countByAuthor(store, scope, `${MEMBER} AND edit_count > 0`, 1000, { sum: 'SUM(edit_count)' });

  // Deletions by members, minus originals the bot itself replaced (link fixing posts the relay first,
  // then deletes the original). Regret relays come AFTER the deletion, so they never match.
  const deletionRows = store.db
    .prepare(
      `SELECT o.author_id, MAX(o.author_name) AS author_name, COUNT(*) AS n FROM messages o
       WHERE ${scopeSql(scope, 'o').where} AND o.source = 'human' AND o.deleted_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM messages r
           WHERE r.channel_id = o.channel_id AND r.source = 'relay' AND r.relay_kind IS NOT 'regret'
             AND (r.author_id = o.author_id OR (r.author_id IS NULL AND r.author_name = o.author_name))
             AND r.created_at >= o.created_at
             AND r.created_at <= o.deleted_at + ${DELETE_CLOCK_SLACK_MS}
             AND r.created_at <= o.created_at + ${BOT_REPLACEMENT_WINDOW_MS})
       GROUP BY COALESCE(o.author_id, 'name:' || o.author_name)
       ORDER BY n DESC, author_name ASC`,
    )
    .all(scopeSql(scope, 'o').params) as AuthorRow[];

  const longestRow = store.db
    .prepare(
      `SELECT author_id, author_name, content, id, channel_id, guild_id, length(content) AS len FROM messages
       WHERE ${s.where} AND ${live} ORDER BY len DESC, created_at ASC LIMIT 1`,
    )
    .get(s.params) as
    | {
        author_id: string | null;
        author_name: string;
        content: string;
        id: string;
        channel_id: string;
        guild_id: string | null;
        len: number;
      }
    | undefined;

  let botPings: WrappedStats['botPings'] = { total: 0, botReplies: 0 };
  if (opts.botUserId) {
    const pingCondition = `${live} AND (
      instr(content, @botMention) > 0 OR instr(content, @botNickMention) > 0
      OR EXISTS (SELECT 1 FROM messages b WHERE b.id = messages.reply_to_id AND b.source = 'bot'))`;
    const pingRows = countByAuthor(store, scope, pingCondition, 1000, {
      params: { botMention: `<@${opts.botUserId}>`, botNickMention: `<@!${opts.botUserId}>` },
    });
    const replies = store.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${s.where} AND source = 'bot' AND deleted_at IS NULL`)
      .get(s.params) as { n: number };
    botPings = { total: total(pingRows), top: pingRows[0] && toAuthorCount(pingRows[0]), botReplies: replies.n };
  }

  return {
    totalMessages: totals.n,
    activeMembers: totals.people,
    topMembers,
    busiestDay: busiestDay ? { date: busiestDay[0], count: busiestDay[1] } : undefined,
    busiestHour: busiestHour ? { hour: busiestHour[0], count: busiestHour[1] } : undefined,
    topChannel: topChannel ? { channelId: topChannel.channel_id, count: topChannel.n } : undefined,
    topEmojis,
    links,
    voice: { total: total(voiceRows), top: voiceRows[0] && toAuthorCount(voiceRows[0]) },
    regrets: { total: total(regretRows), top: regretRows.slice(0, 3).map(toAuthorCount) },
    edits: { total: total(editRows), top: editRows[0] && toAuthorCount(editRows[0]) },
    deletions: { total: total(deletionRows), top: deletionRows[0] && toAuthorCount(deletionRows[0]) },
    longest:
      longestRow && longestRow.len > 0
        ? {
            authorId: longestRow.author_id,
            authorName: longestRow.author_name,
            length: longestRow.len,
            content: longestRow.content,
            messageId: longestRow.id,
            channelId: longestRow.channel_id,
            guildId: longestRow.guild_id,
          }
        : undefined,
    botPings,
  };
}
