// Everything the search tools need around the store: who "author" and "channel" arguments refer to,
// which archived channels the asking member is allowed to read, and how an archived message is shown
// to the model.
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { getMemoryStore } from '../ai/memory';
import type { Identity } from '../ai/memory/memoryStore';
import { foldMembers } from '../ai/people';
import { formatTimestampET } from '../ai/utils';
import { config } from '../config';
import { accountIdsFor, canonicalUserId } from '../linkedAccounts';
import { logger } from '../logger';
import type { ArchiveStore, ArchivedChannel, ArchivedMessage, ArchivedReaction } from './archiveStore';
import { isIgnoredChannel, isThreadType } from './ingest';

/** The permission view of a guild channel search needs; a discord.js GuildChannel/ThreadChannel fits. */
export type PermissionedChannel = {
  id: string;
  type: number;
  name?: string;
  parentId?: string | null;
  permissionsFor(memberOrRole: never): { has(permission: bigint): boolean } | null;
};

/** The guild view search needs; a discord.js Guild fits. */
export type GuildLike = {
  id: string;
  channels: { cache: { get(id: string): unknown } };
};

type PermissionTarget = unknown;

function guildChannel(guild: GuildLike, id: string | null | undefined): PermissionedChannel | undefined {
  if (!id) return undefined;
  const channel = guild.channels.cache.get(id) as PermissionedChannel | undefined;
  return channel && typeof channel.permissionsFor === 'function' ? channel : undefined;
}

function canView(channel: PermissionedChannel, target: PermissionTarget): boolean {
  try {
    return channel.permissionsFor(target as never)?.has(PermissionFlagsBits.ViewChannel) ?? false;
  } catch (error) {
    logger.debug(`archive: permission check failed for channel ${channel.id}:`, error);
    return false;
  }
}

/**
 * Whether messages of an archived channel may be shown to `target` (a GuildMember or Role):
 * the channel's (or, for a thread, its parent's) ViewChannel permission decides. Private threads are
 * only readable from inside the thread itself; channels the server no longer has, and ignored
 * channels, are never readable.
 */
export function makeChannelAccess(
  guild: GuildLike | null | undefined,
  target: PermissionTarget,
  opts: { currentChannelId?: string } = {},
): (channel: ArchivedChannel) => boolean {
  return (channel) => {
    const parentId = isThreadType(channel.type) ? channel.parentId : null;
    if (isIgnoredChannel(channel.id, parentId)) return false;
    if (channel.id === opts.currentChannelId) return true;
    if (!guild || channel.guildId !== guild.id || !target) return false;
    if (channel.type === ChannelType.PrivateThread) return false;
    // Threads inherit their parent's visibility; archived threads are not in the cache, their parent is.
    const permissionSource = isThreadType(channel.type)
      ? guildChannel(guild, parentId)
      : guildChannel(guild, channel.id);
    return permissionSource ? canView(permissionSource, target) : false;
  };
}

/** A guild whose roles can be listed (for audience checks); a discord.js Guild fits. */
export type AudienceGuild = GuildLike & { roles: { cache: { values(): Iterable<unknown> } } };

/** The parts of the triggering message reply access needs; a discord.js Message fits. */
export type ReplyContext = {
  guild: GuildLike | null;
  member: unknown;
  channelId: string;
  channel?: unknown;
};

/** Who may see what the bot shows in its reply, per archived channel (see replyAccessFor). */
export type ReplyAccess = {
  /** The asker can read the channel. */
  asker: (channel: ArchivedChannel) => boolean;
  /** Everyone who can read the reply can read the channel too. */
  audience: (channel: ArchivedChannel) => boolean;
  /** Both: the channel's messages may be shown in the reply. */
  allows: (channel: ArchivedChannel) => boolean;
};

function hasRoles(guild: GuildLike): guild is AudienceGuild {
  const roles = (guild as Partial<AudienceGuild>).roles;
  return typeof roles?.cache?.values === 'function';
}

function asPermissioned(channel: unknown): PermissionedChannel | undefined {
  const candidate = channel as Partial<PermissionedChannel> | null | undefined;
  return candidate && typeof candidate.permissionsFor === 'function' ? (candidate as PermissionedChannel) : undefined;
}

/**
 * Which archived channels' messages the bot may show in its reply to `message` (search results, a linked
 * message's context, a linked video). The reply is posted in the message's channel, so two rules apply:
 * the asker must be able to read the channel (makeChannelAccess), and the channel must be at least as
 * visible as the reply's channel (makeAudienceAccess), or a private channel (mod logs, a two-person
 * channel) would be quoted to everyone reading the reply: an admin asking in #general, or "Ask Fridge" on
 * a message by someone who can read more than the member who clicked it. The reply's own channel always
 * counts. Without a guild, or when the reply channel's audience can't be read, nothing else does.
 */
export function replyAccessFor(message: ReplyContext): ReplyAccess {
  const { guild, channelId } = message;
  const asker = makeChannelAccess(guild, message.member, { currentChannelId: channelId });
  const reply = asPermissioned(message.channel) ?? (guild ? guildChannel(guild, channelId) : undefined);
  const audience: (channel: ArchivedChannel) => boolean =
    guild && reply && hasRoles(guild)
      ? makeAudienceAccess(guild, reply)
      : (channel) => channel.id === channelId && asker(channel);
  return { asker, audience, allows: (channel) => asker(channel) && audience(channel) };
}

/** The archived channel ids `access` allows, for ArchiveFilters.allowedChannelIds. */
export function allowedChannelIds(store: ArchiveStore, access: (channel: ArchivedChannel) => boolean): string[] {
  return store
    .listChannels()
    .filter(access)
    .map((c) => c.id);
}

// ---------------------------------------------------------------- author resolution

export type ResolvedAuthor = {
  ids: string[];
  names: string[];
  botOnly: boolean;
  /** How the resolution reads to the model, e.g. "Remi" or "Remi, Rémi L.". */
  label: string;
};

const SELF_WORDS = new Set(['me', 'myself', 'i', 'moi']);
const BOT_WORDS = new Set(['you', 'yourself', 'bot', 'the bot']);

function normalizeName(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/^@+/, '').trim();
}

function safeIdentities(): Identity[] {
  try {
    return getMemoryStore().getAllIdentities();
  } catch (error) {
    logger.warn('archive: could not read identities:', error);
    return [];
  }
}

/**
 * Resolves an "author" argument: an @-mention or raw id, "me", the bot itself, or any name a member
 * goes by (display name, Discord handle, first-seen name, IRL name, alias, on any of their linked
 * accounts) — exact matches first, then partial ones
 * (so "remi" finds "Remi L." and an IRL name "Rémi Lachance"). Falls back to author names seen in
 * the archive for people the identity table doesn't know. Undefined when nobody matches.
 */
export function resolveAuthor(
  text: string,
  ctx: { store: ArchiveStore; requesterId?: string; botUserId?: string; botNames?: string[] },
): ResolvedAuthor | undefined {
  const raw = text.trim();
  if (!raw) return undefined;
  // Members, not accounts: a linked side account's names find its member, and a member's messages are
  // searched under every account id (the archive stores the main id; older rows may carry a side id).
  const members = foldMembers(safeIdentities());
  const nameOf = (id: string) => members.find((m) => m.userId === canonicalUserId(id))?.displayName;

  const mention = raw.match(/^<@!?(\d{15,21})>$/) ?? raw.match(/^(\d{15,21})$/);
  if (mention) {
    const id = mention[1];
    if (id === ctx.botUserId) return { ids: [], names: [], botOnly: true, label: 'you (the bot)' };
    return { ids: accountIdsFor(id), names: [], botOnly: false, label: nameOf(id) ?? `user ${id}` };
  }

  const needle = normalizeName(raw);
  if (SELF_WORDS.has(needle) && ctx.requesterId) {
    return {
      ids: accountIdsFor(ctx.requesterId),
      names: [],
      botOnly: false,
      label: nameOf(ctx.requesterId) ?? 'the asker',
    };
  }
  const botNames = (ctx.botNames ?? []).map(normalizeName);
  if (BOT_WORDS.has(needle) || botNames.includes(needle)) {
    return { ids: [], names: [], botOnly: true, label: 'you (the bot)' };
  }

  // Every name a member goes by (display name, @handle, first-seen, IRL name, nicknames), all accounts.
  const exact = members.filter((m) => m.names.some((n) => normalizeName(n) === needle));
  const partial =
    exact.length > 0 || needle.length < 3
      ? []
      : members.filter((m) =>
          m.names.some((n) => {
            const name = normalizeName(n);
            return name.includes(needle) || name.split(/\s+/).includes(needle);
          }),
        );
  const matched = exact.length > 0 ? exact : partial;
  if (matched.length > 0) {
    return {
      ids: [...new Set(matched.flatMap((m) => accountIdsFor(m.userId)))],
      names: [],
      botOnly: false,
      label: matched.map((m) => m.displayName).join(', '),
    };
  }

  // People the identity table has never seen (left the server, or only ever relayed).
  let archived = ctx.store.findAuthorsByName(raw.replace(/^@+/, ''), 'exact');
  if (archived.length === 0 && needle.length >= 3)
    archived = ctx.store.findAuthorsByName(raw.replace(/^@+/, ''), 'substring');
  if (archived.length === 0) return undefined;
  return {
    ids: [...new Set(archived.map((a) => a.authorId).filter((id): id is string => Boolean(id)))],
    names: [...new Set(archived.filter((a) => !a.authorId).map((a) => a.authorName))],
    botOnly: false,
    label: [...new Set(archived.map((a) => a.authorName))].join(', '),
  };
}

// ---------------------------------------------------------------- channel resolution

function normalizeChannelName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Resolves a "channel" argument (a <#mention>, an id, or a name with or without '#', emoji prefixes
 * and dashes ignored) to archived channel ids. Exact name matches win over partial ones.
 */
export function resolveChannels(text: string, store: ArchiveStore): ArchivedChannel[] {
  const raw = text.trim();
  if (!raw) return [];
  const idMatch = raw.match(/^<#(\d{15,21})>$/) ?? raw.match(/^(\d{15,21})$/);
  const channels = store.listChannels();
  if (idMatch) {
    const found = channels.find((c) => c.id === idMatch[1]);
    return found ? [found] : [];
  }
  const needle = normalizeChannelName(raw);
  if (!needle) return [];
  const exact = channels.filter((c) => normalizeChannelName(c.name) === needle);
  if (exact.length > 0) return exact;
  return channels.filter((c) => normalizeChannelName(c.name).includes(needle));
}

// ---------------------------------------------------------------- rendering

const MAX_LINE_CONTENT = 300;
const MAX_REACTIONS_SHOWN = 3;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function jumpLink(message: Pick<ArchivedMessage, 'guildId' | 'channelId' | 'id'>): string {
  return `https://discord.com/channels/${message.guildId ?? '@me'}/${message.channelId}/${message.id}`;
}

/** Name lookups for rendering, loaded once per tool call. */
export type RenderContext = {
  nameOfUser: (id: string) => string | undefined;
  nameOfChannel: (id: string) => string | undefined;
};

export function makeRenderContext(store: ArchiveStore): RenderContext {
  const identities = new Map(safeIdentities().map((i) => [i.discord_user_id, i.display_name]));
  const channels = new Map(store.listChannels().map((c) => [c.id, c.name]));
  return {
    nameOfUser: (id) => identities.get(id),
    nameOfChannel: (id) => channels.get(id),
  };
}

/** Discord markup made readable for a model: mentions → names, custom emojis → :name:, timestamps → ET. */
export function renderContent(content: string, ctx: RenderContext): string {
  return content
    .replace(/<@!?(\d+)>/g, (_m, id: string) => `@${ctx.nameOfUser(id) ?? 'someone'}`)
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#(\d+)>/g, (_m, id: string) => `#${ctx.nameOfChannel(id) ?? 'channel'}`)
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(\d+)(?::\w)?>/g, (_m, secs: string) => `${formatTimestampET(new Date(Number(secs) * 1000))} ET`)
    .replace(/\s*\n\s*/g, ' ↵ ')
    .trim();
}

/** The message's text plus short markers for voice, files and link previews. */
function describeBody(message: ArchivedMessage, ctx: RenderContext): string {
  const parts: string[] = [];
  const text = renderContent(message.content, ctx);
  if (text) parts.push(truncate(text, MAX_LINE_CONTENT));

  if (message.hasAudio) {
    parts.push(message.transcript ? `[voice: "${truncate(message.transcript.trim(), 200)}"]` : '[voice message]');
  }
  const files = message.attachments.filter((a) => !a.type?.startsWith('audio/'));
  if (files.length > 0) parts.push(`[attached: ${truncate(files.map((a) => a.name).join(', '), 120)}]`);
  const embedTitle = message.embeds.find((e) => e.title)?.title;
  if (embedTitle && !text.includes(embedTitle)) parts.push(`[link: ${truncate(embedTitle, 120)}]`);
  if (parts.length === 0 && message.extraText)
    parts.push(`[${truncate(message.extraText.replace(/\s*\n\s*/g, ' · '), 200)}]`);
  const body = parts.length > 0 ? parts.join(' ') : '(no text)';
  const reactions = describeReactions(message.reactions);
  return reactions ? `${body} ${reactions}` : body;
}

/** The top reactions as `[reactions: 😂×3 :kekw:×2]`: how the group took the message. */
function describeReactions(reactions: ArchivedReaction[]): string | undefined {
  const top = [...reactions].sort((a, b) => b.count - a.count).slice(0, MAX_REACTIONS_SHOWN);
  if (top.length === 0) return undefined;
  return `[reactions: ${top.map((r) => `${r.id ? `:${r.name}:` : r.name}×${r.count}`).join(' ')}]`;
}

export function displayAuthor(message: ArchivedMessage, ctx: RenderContext): string {
  return (message.authorId ? ctx.nameOfUser(message.authorId) : undefined) ?? message.authorName;
}

/** `[YYYY-MM-DD HH:MM ET] #channel Author: content (jump link)` */
export function formatMessageLine(message: ArchivedMessage, ctx: RenderContext): string {
  const when = formatTimestampET(new Date(message.createdAt));
  const channel = ctx.nameOfChannel(message.channelId) ?? message.channelId;
  return `[${when} ET] #${channel} ${displayAuthor(message, ctx)}: ${describeBody(message, ctx)} (${jumpLink(message)})`;
}

// ---------------------------------------------------------------- archive status

/**
 * A heads-up line when the archive can't be complete yet: a configured channel's history import is
 * still running (or failed). Undefined when every configured channel is fully imported.
 */
export function backfillNotice(store: ArchiveStore): string | undefined {
  const pending = config.archive.backfillChannels.filter((id) => !store.getBackfillState(id)?.done);
  if (pending.length === 0 || !config.archive.backfillEnabled) return undefined;
  const oldest = store.oldestTimestamp();
  const reach = oldest ? ` (it currently reaches back to ${formatTimestampET(new Date(oldest)).slice(0, 10)})` : '';
  return `Note: the archive is still importing older history${reach}, so older messages may be missing.`;
}

/**
 * Channel access for a PUBLIC post in `target` (Wrapped): a channel counts only when every role that
 * can read the target channel can also read it, i.e. its audience is at least the post's audience.
 * Private channels (mod logs, a two-person channel) therefore never leak into a server-wide post.
 * Private threads never count; ignored channels never count.
 */
export function makeAudienceAccess(
  guild: AudienceGuild,
  target: PermissionedChannel,
): (channel: ArchivedChannel) => boolean {
  const audience = [...guild.roles.cache.values()].filter((role) => canView(target, role));
  return (channel) => {
    const parentId = isThreadType(channel.type) ? channel.parentId : null;
    if (isIgnoredChannel(channel.id, parentId)) return false;
    if (channel.guildId !== guild.id) return false;
    if (channel.id === target.id) return true;
    // Nobody reads the target through a role (member overwrites only): nothing else is provably as public.
    if (audience.length === 0) return false;
    if (channel.type === ChannelType.PrivateThread) return false;
    const permissionSource = isThreadType(channel.type)
      ? guildChannel(guild, parentId)
      : guildChannel(guild, channel.id);
    if (!permissionSource) return false;
    return audience.every((role) => canView(permissionSource, role));
  };
}
