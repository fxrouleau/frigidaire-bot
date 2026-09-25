// Search over the local message archive (see src/archive/): what was said, by whom, when, and the
// conversation around a message. Results only ever include channels the asking member can read.
import type { Message } from 'discord.js';
import { type ArchiveFilters, type ArchiveStore, compareSnowflakes, getArchiveStore } from '../../archive/archiveStore';
import { channelInfoOf, isArchivableChannel, toArchiveInput } from '../../archive/ingest';
import {
  allowedChannelIds,
  backfillNotice,
  formatMessageLine,
  makeChannelAccess,
  makeRenderContext,
  resolveAuthor,
  resolveChannels,
} from '../../archive/search';
import { config } from '../../config';
import { logger } from '../../logger';
import type { ToolDefinition, ToolHandlerContext } from '../types';
import { parseEasternDateTime } from '../utils';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const DEFAULT_CONTEXT = 5;
const MAX_CONTEXT = 25;

function optionalString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Channels the triggering message's author may read, plus the channel they are asking from. */
function accessFor(message: Message, store: ArchiveStore): string[] {
  const access = makeChannelAccess(message.guild, message.member, { currentChannelId: message.channelId });
  return allowedChannelIds(store, access);
}

function botNames(message: Message): string[] {
  const user = message.client?.user;
  return [user?.username, user?.displayName, message.guild?.members?.me?.displayName].filter(
    (n): n is string => typeof n === 'string' && n.length > 0,
  );
}

function withNotice(text: string, store: ArchiveStore): string {
  const notice = backfillNotice(store);
  return notice ? `${text}\n${notice}` : text;
}

async function searchMessages(ctx: ToolHandlerContext, args: Record<string, unknown>): Promise<string> {
  const store = getArchiveStore();
  if (store.countMessages() === 0) {
    return withNotice(
      'The message archive is empty — nothing has been indexed yet, so there is nothing to search.',
      store,
    );
  }

  const query = optionalString(args.query);
  const authorArg = optionalString(args.author);
  const channelArg = optionalString(args.channel);
  const afterArg = optionalString(args.after);
  const beforeArg = optionalString(args.before);
  const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

  if (!query && !authorArg && !channelArg && !afterArg && !beforeArg) {
    return 'Give me something to search for: keywords, an author, a channel, or a time range.';
  }

  const filters: ArchiveFilters = {};
  const described: string[] = [];

  if (authorArg) {
    const author = resolveAuthor(authorArg, {
      store,
      requesterId: ctx.message.author.id,
      botUserId: ctx.message.client?.user?.id,
      botNames: botNames(ctx.message),
    });
    if (!author)
      return `I don't know anyone called "${authorArg}" — no messages in the archive from anyone by that name.`;
    if (author.botOnly) filters.botOnly = true;
    else {
      filters.authorIds = author.ids;
      filters.authorNames = author.names;
    }
    described.push(`by ${author.label}`);
  }

  if (channelArg) {
    const channels = resolveChannels(channelArg, store);
    if (channels.length === 0) return `No channel matching "${channelArg}" in the archive.`;
    filters.channelIds = channels.map((c) => c.id);
    described.push(`in ${channels.map((c) => `#${c.name}`).join(', ')}`);
  }

  if (afterArg) {
    const after = parseEasternDateTime(afterArg);
    if (!after) return `Couldn't read the date "${afterArg}". Use Eastern time as YYYY-MM-DD or YYYY-MM-DD HH:MM.`;
    filters.afterMs = after.getTime();
    described.push(`after ${afterArg}`);
  }
  if (beforeArg) {
    const before = parseEasternDateTime(beforeArg);
    if (!before) return `Couldn't read the date "${beforeArg}". Use Eastern time as YYYY-MM-DD or YYYY-MM-DD HH:MM.`;
    filters.beforeMs = before.getTime();
    described.push(`before ${beforeArg}`);
  }

  filters.allowedChannelIds = accessFor(ctx.message, store);
  const render = makeRenderContext(store);
  const scope = described.length > 0 ? ` ${described.join(' ')}` : '';

  if (query) {
    const result = store.search(query, filters, limit);
    if (result.hits.length === 0) {
      return withNotice(`No messages matching "${query}"${scope}.`, store);
    }
    const partial = result.hits.some((h) => h.tier === 'any');
    const header = `${result.hits.length}${result.truncated ? '+' : ''} message(s) matching "${query}"${scope}, best matches first${
      partial ? ' (later ones match only some of the words)' : ''
    }:`;
    return withNotice([header, ...result.hits.map((m) => formatMessageLine(m, render))].join('\n'), store);
  }

  const { messages, total } = store.listRecent(filters, limit);
  if (messages.length === 0) return withNotice(`No messages${scope}.`, store);
  const header =
    total > messages.length
      ? `${total.toLocaleString('en-US')} message(s)${scope}; the latest ${messages.length}, oldest first (narrow the time range for others):`
      : `${total} message(s)${scope}, oldest first:`;
  return withNotice([header, ...messages.map((m) => formatMessageLine(m, render))].join('\n'), store);
}

const JUMP_LINK = /discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/;

function parseMessageRef(raw: string): { channelId?: string; messageId: string } | undefined {
  const link = raw.match(JUMP_LINK);
  if (link) return { channelId: link[2], messageId: link[3] };
  const id = raw.match(/^\s*(\d{15,21})\s*$/);
  return id ? { messageId: id[1] } : undefined;
}

async function getMessageContext(ctx: ToolHandlerContext, args: Record<string, unknown>): Promise<string> {
  const store = getArchiveStore();
  const raw = optionalString(args.message);
  const ref = raw ? parseMessageRef(raw) : undefined;
  if (!ref) return 'Pass a message id or a Discord message link (https://discord.com/channels/…).';
  const before = clampInt(args.before, DEFAULT_CONTEXT, 0, MAX_CONTEXT);
  const after = clampInt(args.after, DEFAULT_CONTEXT, 0, MAX_CONTEXT);

  const target = store.getMessage(ref.messageId);
  if (!target) {
    const live = await contextFromDiscord(ctx.message, ref, before, after, store);
    return live ?? withNotice("That message isn't in the archive and I couldn't fetch it from Discord.", store);
  }
  if (!accessFor(ctx.message, store).includes(target.channelId)) {
    return "That message is in a channel you can't read, so I can't show it.";
  }
  if (target.deletedAt !== null) return 'That message was deleted.';

  const render = makeRenderContext(store);
  const window = store.getContext(target, before, after);
  const lines = [
    ...window.before.map((m) => `  ${formatMessageLine(m, render)}`),
    `→ ${formatMessageLine(target, render)}`,
    ...window.after.map((m) => `  ${formatMessageLine(m, render)}`),
  ];
  const channel = render.nameOfChannel(target.channelId) ?? target.channelId;
  return [`Conversation around that message in #${channel} (→ marks it):`, ...lines].join('\n');
}

/**
 * Fallback for a message the archive doesn't have (a channel not imported yet): read the surrounding
 * messages straight from Discord. Read-only on purpose — inserting an isolated old window would break
 * the archive's "contiguous from its oldest message" invariant the backfill relies on. Same access
 * rule as the archive: the asker must be able to read the channel, ignored channels stay off-limits.
 */
async function contextFromDiscord(
  asker: Message,
  ref: { channelId?: string; messageId: string },
  before: number,
  after: number,
  store: ArchiveStore,
): Promise<string | undefined> {
  const guild = asker.guild;
  if (!guild) return undefined;
  const channelId = ref.channelId ?? asker.channelId;
  try {
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
    if (!channel || !channel.isTextBased() || !isArchivableChannel(channel)) return undefined;
    const row = { ...channelInfoOf(channel), guildId: guild.id, updatedAt: 0 };
    const access = makeChannelAccess(guild, asker.member, { currentChannelId: asker.channelId });
    if (!access(row)) return "That message is in a channel you can't read, so I can't show it.";

    const fetched = await channel.messages.fetch({ around: ref.messageId, limit: Math.min(100, before + after + 1) });
    const ordered = [...fetched.values()].sort((a, b) => compareSnowflakes(a.id, b.id));
    const index = ordered.findIndex((m) => m.id === ref.messageId);
    if (index < 0) return undefined;

    const archived = makeRenderContext(store);
    const render = {
      ...archived,
      nameOfChannel: (id: string) => archived.nameOfChannel(id) ?? (id === channel.id ? channel.name : undefined),
    };
    const lines: string[] = [];
    for (const m of ordered.slice(Math.max(0, index - before), index + after + 1)) {
      const input = toArchiveInput(m);
      if (!input) continue;
      const line = formatMessageLine({ ...input, editCount: 0, deletedAt: null }, render);
      lines.push(m.id === ref.messageId ? `→ ${line}` : `  ${line}`);
    }
    if (lines.length === 0) return undefined;
    return [
      `Conversation around that message in #${channel.name} (read live from Discord; → marks it):`,
      ...lines,
    ].join('\n');
  } catch (error) {
    logger.debug(`get_message_context: live fetch of ${ref.messageId} failed:`, error);
    return undefined;
  }
}

function handleErrors(
  name: string,
  handler: (ctx: ToolHandlerContext, args: Record<string, unknown>) => Promise<string>,
): (ctx: ToolHandlerContext, args: Record<string, unknown>) => Promise<string> {
  return async (ctx, args) => {
    try {
      return await handler(ctx, args);
    } catch (error) {
      logger.warn(`${name} failed:`, error);
      return 'The message archive is unavailable right now.';
    }
  };
}

const searchMessagesTool: ToolDefinition = {
  name: 'search_messages',
  description:
    "Search this server's message history (years of it). Use it when someone asks what was said or who said something, when something happened, what someone said about a topic, or to dig up an old link, clip, or quote — instead of guessing or saying you don't remember. Keyword search: pass a few distinctive words, not a whole sentence. Filters: author (name, nickname, IRL name or @mention), channel, and an Eastern-time range. Leave out the query to list what someone said in a time range. Each result ends with a jump link; pass one to get_message_context to read the surrounding conversation.",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keywords. Messages containing all of them rank first, then ones with some of them.',
      },
      author: {
        type: 'string',
        description: 'Only messages by this person: display name, nickname, IRL name, alias, or @mention.',
      },
      channel: {
        type: 'string',
        description: 'Only this channel (name like "clips", or an id). Default: all channels.',
      },
      after: {
        type: 'string',
        description: 'Only messages after this Eastern time: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM".',
      },
      before: { type: 'string', description: 'Only messages before this Eastern time, same format.' },
      limit: { type: 'number', description: `Max results, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT}).` },
    },
    required: [],
    additionalProperties: false,
  },
  isEnabled: () => config.archive.enabled,
  handler: handleErrors('search_messages', searchMessages),
};

const getMessageContextTool: ToolDefinition = {
  name: 'get_message_context',
  description:
    'Show the conversation around one archived message: the messages right before and after it in its channel. Use it after search_messages when a hit needs context (what was being replied to, how the argument went), or when someone links a message.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The message id or its Discord jump link.' },
      before: {
        type: 'number',
        description: `Messages to show before it, 0-${MAX_CONTEXT} (default ${DEFAULT_CONTEXT}).`,
      },
      after: {
        type: 'number',
        description: `Messages to show after it, 0-${MAX_CONTEXT} (default ${DEFAULT_CONTEXT}).`,
      },
    },
    required: ['message'],
    additionalProperties: false,
  },
  isEnabled: () => config.archive.enabled,
  handler: handleErrors('get_message_context', getMessageContext),
};

export const messageSearchTools: ToolDefinition[] = [searchMessagesTool, getMessageContextTool];
