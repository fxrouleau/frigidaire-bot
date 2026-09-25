// Turning discord.js messages into archive rows, and the live ingest paths (create / edit / delete).
//
// What gets archived: regular and reply messages (plus the bot's own slash/context-command responses)
// in guild text and announcement channels and their threads. Attribution goes through
// attributeMessage(): link-fix and regret relays count as the member they were posted for, other bots
// and other integrations' webhooks are skipped, and the bot's own messages are kept as source 'bot'
// (so "what did you say about X" works) but never count as a member's message in stats. author_id is
// always the member's MAIN account: a linked side account's messages (LINKED_ACCOUNTS) are stored under
// the main id (the raw account id is not kept), so stats, search and Wrapped count one person.
import { ChannelType, type Message, MessageType, type PartialMessage } from 'discord.js';
import { getCachedTranscript } from '../ai/media';
import { config } from '../config';
import { canonicalUserId } from '../linkedAccounts';
import { logger } from '../logger';
import { attributeMessage, getRelay, getRelays } from '../relay';
import {
  type ArchiveChannelInput,
  type ArchiveMessageInput,
  type ArchiveStore,
  type ArchivedAttachment,
  type ArchivedEmbed,
  type DeletionKind,
  VOICE_MESSAGE_FLAG,
  getArchiveStore,
} from './archiveStore';
import { reactionsOf } from './reactions';

const ARCHIVABLE_CHANNEL_TYPES: ReadonlySet<ChannelType> = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

// discord.js' own "not a system message" list: joins, pins, boosts, thread-created notices etc. are
// authored by the member they concern and would otherwise count as that member's messages.
const ARCHIVABLE_MESSAGE_TYPES: ReadonlySet<MessageType> = new Set([
  MessageType.Default,
  MessageType.Reply,
  MessageType.ChatInputCommand,
  MessageType.ContextMenuCommand,
]);

const THREAD_TYPES: ReadonlySet<ChannelType> = new Set([
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

const MAX_EXTRA_TEXT = 2000;
const MAX_EMBED_DESCRIPTION = 300;

/** The channel shape ingest reads; a discord.js channel satisfies it. */
export type ArchivableChannelLike = {
  id: string;
  type: ChannelType;
  name?: string | null;
  parentId?: string | null;
  guildId?: string | null;
};

export function isThreadType(type: number): boolean {
  return THREAD_TYPES.has(type as ChannelType);
}

/** True when the channel (or, for a thread, its parent) is in ARCHIVE_IGNORE_CHANNELS. */
export function isIgnoredChannel(channelId: string, parentId: string | null | undefined): boolean {
  const ignored = config.archive.ignoredChannels;
  if (ignored.length === 0) return false;
  return ignored.includes(channelId) || (parentId ? ignored.includes(parentId) : false);
}

/** Channels the archive covers: guild text/announcement channels and threads, minus the ignore list. */
export function isArchivableChannel(channel: ArchivableChannelLike): boolean {
  if (!ARCHIVABLE_CHANNEL_TYPES.has(channel.type)) return false;
  const parentId = isThreadType(channel.type) ? (channel.parentId ?? null) : null;
  return !isIgnoredChannel(channel.id, parentId);
}

export function channelInfoOf(channel: ArchivableChannelLike): ArchiveChannelInput {
  return {
    id: channel.id,
    guildId: channel.guildId ?? null,
    name: channel.name ?? channel.id,
    parentId: isThreadType(channel.type) ? (channel.parentId ?? null) : null,
    type: channel.type,
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function attachmentsOf(message: Message): ArchivedAttachment[] {
  return [...message.attachments.values()].map((a) => ({
    name: a.name,
    type: a.contentType ?? null,
    size: a.size ?? 0,
    url: a.url,
  }));
}

function embedsOf(message: Message): ArchivedEmbed[] {
  const embeds: ArchivedEmbed[] = [];
  for (const embed of message.embeds) {
    const entry: ArchivedEmbed = {};
    if (embed.title) entry.title = truncate(embed.title, 256);
    if (embed.url) entry.url = embed.url;
    if (embed.description) entry.description = truncate(embed.description, MAX_EMBED_DESCRIPTION);
    if (Object.keys(entry).length > 0) embeds.push(entry);
  }
  return embeds;
}

/**
 * Searchable text that is not the body: link-preview titles and descriptions (a fixed tweet's text
 * lives there), attachment and sticker names, forwarded messages, poll questions.
 */
function extraTextOf(
  message: Message,
  attachments: ArchivedAttachment[],
  embeds: ArchivedEmbed[],
  voice: boolean,
): string {
  const parts: string[] = [];
  for (const embed of embeds) {
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
  }
  // A voice message's attachment is always "voice-message.ogg": noise, not a name anyone searches for.
  if (!voice) for (const a of attachments) parts.push(a.name);
  for (const sticker of message.stickers?.values() ?? []) parts.push(`sticker ${sticker.name}`);
  for (const snapshot of message.messageSnapshots?.values() ?? []) {
    if (snapshot.content) parts.push(`forwarded: ${snapshot.content}`);
  }
  if (message.poll) {
    const answers = [...message.poll.answers.values()].map((a) => a.text).filter((t): t is string => Boolean(t));
    parts.push(`poll: ${message.poll.question.text ?? ''} ${answers.join(' / ')}`.trim());
  }
  return truncate(parts.join('\n'), MAX_EXTRA_TEXT);
}

/**
 * The archive row for a message, or undefined when the message is not archived (DMs, system messages,
 * other bots, other integrations' webhooks, unsupported or ignored channels, partial messages).
 */
export function toArchiveInput(message: Message): ArchiveMessageInput | undefined {
  if (message.partial) return undefined;
  if (!message.guildId) return undefined;
  if (!ARCHIVABLE_MESSAGE_TYPES.has(message.type)) return undefined;
  const channel = message.channel as ArchivableChannelLike;
  if (!isArchivableChannel(channel)) return undefined;

  let authorId: string | null;
  let authorName: string;
  let source: ArchiveMessageInput['source'];
  let relayKind: string | null = null;

  const botUserId = message.client?.user?.id;
  // The bot's own messages first: interaction responses carry a webhook id (the application's) and
  // would otherwise look like one of the bot's relays to attributeMessage().
  if (botUserId && message.author.id === botUserId) {
    authorId = botUserId;
    authorName = message.member?.displayName || message.author.displayName || message.author.username;
    source = 'bot';
  } else {
    const attribution = attributeMessage(message);
    if (!attribution) return undefined;
    authorId = attribution.authorId ?? null;
    authorName = attribution.authorName;
    source = attribution.source;
    // The registry row is usually written a moment AFTER Discord delivers the webhook message; the
    // relay reconciler fills the kind in shortly afterwards when it is missing here.
    if (source === 'relay') relayKind = getRelay(message.id)?.kind ?? null;
  }

  const attachments = attachmentsOf(message);
  const embeds = embedsOf(message);
  const flags = message.flags?.bitfield ?? 0;
  const voice = (flags & VOICE_MESSAGE_FLAG) !== 0;
  const hasAudio = voice || attachments.some((a) => a.type?.startsWith('audio/'));
  const threadParent = isThreadType(channel.type) ? (channel.parentId ?? null) : null;

  return {
    id: message.id,
    guildId: message.guildId,
    channelId: channel.id,
    parentChannelId: threadParent,
    authorId,
    authorName,
    source,
    relayKind,
    content: message.content ?? '',
    extraText: extraTextOf(message, attachments, embeds, voice),
    transcript: hasAudio ? (getCachedTranscript(message.id) ?? null) : null,
    createdAt: message.createdTimestamp,
    editedAt: message.editedTimestamp ?? null,
    replyToId: message.reference?.messageId ?? null,
    flags,
    hasAudio,
    attachments,
    embeds,
    reactions: reactionsOf(message),
  };
}

/**
 * Archives a freshly created message (MessageCreate). Returns true when it was archived. Never throws:
 * the archive is a side channel and must not break message handling.
 */
export function archiveNewMessage(message: Message, store: ArchiveStore = getArchiveStore()): boolean {
  try {
    const input = toArchiveInput(message);
    if (!input) return false;
    store.upsertChannel(channelInfoOf(message.channel as ArchivableChannelLike));
    store.upsertMessage(input);
    if (input.source === 'relay' && (input.relayKind === null || input.authorId === null)) {
      relayReconciler.schedule(input.id);
    }
    return true;
  } catch (error) {
    logger.warn(`archive: failed to archive message ${message.id}:`, error);
    return false;
  }
}

/**
 * Applies an edit (MessageUpdate): new content, a newer edited timestamp (counted as one edit), late
 * link previews (Discord adds embeds after the fact). Only messages already in the archive are updated:
 * inserting an old message here would break the "archive is contiguous from its oldest message"
 * assumption the backfill and gap fill rely on — the backfill picks those messages up anyway.
 *
 * Reactions: a gateway update carries none, and discord.js rebuilds a message it had not cached (posted
 * before the last restart) from that payload as a full message with an EMPTY reaction cache. So the
 * archived counts (kept current by the reaction events) stay as they are, unless the message had to be
 * fetched from the API, whose answer has Discord's real counts.
 */
export async function archiveMessageUpdate(
  message: Message | PartialMessage,
  store: ArchiveStore = getArchiveStore(),
): Promise<boolean> {
  try {
    const archived = store.getMessage(message.id);
    if (!archived) return false;
    if (message.partial) {
      let fetched: Message;
      try {
        fetched = await message.fetch();
      } catch (error) {
        logger.debug(`archive: could not fetch partial message ${message.id} for an edit:`, error);
        return false;
      }
      const input = toArchiveInput(fetched);
      return input ? store.upsertMessage(input) : false;
    }
    const input = toArchiveInput(message);
    if (!input) return false;
    // No await since getMessage(): `archived.reactions` are still the stored ones.
    return store.upsertMessage({ ...input, reactions: archived.reactions });
  } catch (error) {
    logger.warn(`archive: failed to apply an edit to message ${message.id}:`, error);
    return false;
  }
}

/** MessageDelete: marks the messages deleted (their text is scrubbed). */
export function archiveMessageDeletes(
  ids: string[],
  store: ArchiveStore = getArchiveStore(),
  now: number = Date.now(),
  kind: Exclude<DeletionKind, 'channel'> = 'message',
): number {
  try {
    return store.markDeleted(ids, now, kind);
  } catch (error) {
    logger.warn(`archive: failed to mark ${ids.length} message(s) deleted:`, error);
    return 0;
  }
}

/** MessageDeleteBulk: a purge (by a moderator or a bot), so not the authors' own deletions in stats. */
export function archiveBulkDeletes(
  ids: string[],
  store: ArchiveStore = getArchiveStore(),
  now: number = Date.now(),
): number {
  return archiveMessageDeletes(ids, store, now, 'bulk');
}

/** ChannelDelete / ThreadDelete: the channel's messages are gone from Discord, so they go here too. */
export function archiveChannelDelete(
  channelId: string,
  store: ArchiveStore = getArchiveStore(),
  now: number = Date.now(),
): number {
  try {
    const count = store.markChannelDeleted(channelId, now);
    if (count > 0) logger.info(`archive: channel ${channelId} was deleted; marked ${count} message(s) deleted.`);
    return count;
  } catch (error) {
    logger.warn(`archive: failed to mark channel ${channelId}'s messages deleted:`, error);
    return 0;
  }
}

// How far back maintenance looks for unresolved relays and missing transcripts. Older rows are either
// resolved already or predate the relay registry / transcript cache and never will be.
const MAINTENANCE_LOOKBACK_MS = 30 * 86_400_000;
const MAINTENANCE_BATCH = 500;

/**
 * Fills in relay kind and real author from the relay registry for relay rows archived before the
 * registry had them. Returns how many rows changed.
 */
export function reconcileRelays(
  store: ArchiveStore = getArchiveStore(),
  opts: { ids?: string[]; sinceMs?: number } = {},
): number {
  const ids =
    opts.ids ?? store.unresolvedRelayIds(opts.sinceMs ?? Date.now() - MAINTENANCE_LOOKBACK_MS, MAINTENANCE_BATCH);
  if (ids.length === 0) return 0;
  const relays = getRelays(ids);
  let changed = 0;
  for (const relay of relays.values()) {
    if (
      store.setRelayInfo(relay.messageId, {
        // The registry keeps the account the original came from; the archive keys on the person.
        authorId: canonicalUserId(relay.authorId),
        authorName: relay.authorName,
        relayKind: relay.kind,
      })
    ) {
      changed++;
    }
  }
  return changed;
}

/**
 * Copies transcripts the media feature has produced since a voice message was archived (transcription
 * happens on demand, after ingest), so voice messages become searchable by what was said.
 */
export function refreshTranscripts(store: ArchiveStore = getArchiveStore(), sinceMs?: number): number {
  const ids = store.pendingTranscriptIds(sinceMs ?? Date.now() - MAINTENANCE_LOOKBACK_MS, MAINTENANCE_BATCH);
  let filled = 0;
  for (const id of ids) {
    const transcript = getCachedTranscript(id);
    if (transcript && store.setTranscript(id, transcript)) filled++;
  }
  return filled;
}

/**
 * Debounced relay reconciliation: a relay archived before its registry row existed is re-checked a few
 * seconds later (the registry is written right after the webhook post and webhook cleanup return).
 */
export class RelayReconciler {
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly delayMs = 5000,
    private readonly getStore: () => ArchiveStore = getArchiveStore,
  ) {}

  schedule(messageId: string): void {
    this.pending.add(messageId);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    this.timer.unref?.();
  }

  flush(): number {
    this.timer = undefined;
    const ids = [...this.pending];
    this.pending.clear();
    if (ids.length === 0) return 0;
    try {
      return reconcileRelays(this.getStore(), { ids });
    } catch (error) {
      logger.warn('archive: relay reconciliation failed:', error);
      return 0;
    }
  }
}

export const relayReconciler = new RelayReconciler();
