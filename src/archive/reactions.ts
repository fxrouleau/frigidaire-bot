// Reactions per archived message: how the group reacts, and to what. Ingest and backfill store the
// reaction counts a message carries (fetched history includes them, so the backfill yields years of
// data); the reaction events below keep them current afterwards. getReactionProfile() summarizes them
// for features that want to react like the group does.
//
// Keeping counts current: every add/remove is applied as a +1/-1 delta to what the archive already
// holds (ingest, backfill and REST fetches store Discord's real counts). The discord.js reaction cache is
// never copied: it is only complete for messages built from an API fetch or seen being created. An older
// message discord.js rebuilt from a gateway payload (the message a reply points at, or one that was
// edited or pinned since the last restart) is cached as a FULL message with an EMPTY reaction cache,
// because gateway message payloads carry no reactions; copying it would wipe the archived counts.
// Messages the archive doesn't hold (ignored channels, not imported yet) are left alone: the backfill
// brings their reactions along when it reaches them.
import { config } from '../config';
import { logger } from '../logger';
import {
  type ArchiveStore,
  type ArchivedReaction,
  type ReactionProfile,
  type ReactionProfileOptions,
  getArchiveStore,
  reactionKey,
} from './archiveStore';

/** The emoji of a reaction; discord.js' GuildEmoji / ReactionEmoji / ApplicationEmoji fit. */
export type ReactionEmojiLike = { id: string | null; name: string | null; animated?: boolean | null };

/** A reaction as the message's reaction cache holds it; a discord.js MessageReaction fits. */
export type ReactionSnapshotLike = { emoji: ReactionEmojiLike; count: number | null; me: boolean };

/** The message side of a reaction event; a discord.js Message or PartialMessage fits. */
export type ReactionMessageLike = {
  id: string;
  reactions?: { cache: { values(): Iterable<ReactionSnapshotLike> } } | null;
};

/** A reaction event's reaction; a discord.js MessageReaction or PartialMessageReaction fits. */
export type ReactionEventLike = {
  emoji: ReactionEmojiLike;
  message: ReactionMessageLike;
  client?: { user?: { id: string } | null } | null;
};

function toArchivedReaction(emoji: ReactionEmojiLike, count: number, me: boolean): ArchivedReaction | undefined {
  // A custom emoji Discord no longer resolves can arrive without a name; its id still identifies it.
  const name = emoji.name ?? (emoji.id ? 'emoji' : undefined);
  if (!name || count <= 0) return undefined;
  const reaction: ArchivedReaction = { id: emoji.id ?? null, name, count };
  if (emoji.id && emoji.animated) reaction.animated = true;
  if (me) reaction.me = true;
  return reaction;
}

/** The reactions a full message carries (from its reaction cache), in the archive's shape. */
export function reactionsOf(message: Pick<ReactionMessageLike, 'reactions'>): ArchivedReaction[] {
  const cache = message.reactions?.cache;
  if (!cache) return [];
  const reactions: ArchivedReaction[] = [];
  for (const reaction of cache.values()) {
    const archived = toArchivedReaction(reaction.emoji, reaction.count ?? 0, reaction.me);
    if (archived) reactions.push(archived);
  }
  return reactions;
}

/** Applies one user's add (+1) or remove (-1) of an emoji to a stored reaction list. */
export function applyReactionDelta(
  current: ArchivedReaction[],
  emoji: ReactionEmojiLike,
  delta: 1 | -1,
  byBot: boolean,
): ArchivedReaction[] {
  const key = emoji.id ?? emoji.name;
  if (!key) return current;
  const existing = current.find((r) => reactionKey(r) === key);
  const others = current.filter((r) => r !== existing);
  if (!existing) {
    if (delta < 0) return current; // removing something the archive never saw: nothing to undo
    const added = toArchivedReaction(emoji, 1, byBot);
    return added ? [...others, added] : current;
  }
  // A duplicate add from the bot (already reacted) does not count twice, mirroring Discord.
  if (byBot && delta > 0 && existing.me) return current;
  const count = existing.count + delta;
  if (count <= 0) return others;
  const { me: _me, ...rest } = existing;
  const me = byBot ? delta > 0 : existing.me === true;
  return [...others, me ? { ...rest, count, me } : { ...rest, count }];
}

function isEnabled(): boolean {
  return config.archive.enabled;
}

/**
 * The store, or a getter for it: the shared store is only opened once the archive is known to be
 * enabled (opening creates ./data/archive.db), and inside the caller's try so a failure is logged.
 */
type StoreSource = ArchiveStore | (() => ArchiveStore);

function storeOf(source: StoreSource): ArchiveStore {
  return typeof source === 'function' ? source() : source;
}

/** MessageReactionAdd / MessageReactionRemove. Returns true when the archive changed. Never throws. */
export function archiveReactionChange(
  reaction: ReactionEventLike,
  user: { id: string },
  delta: 1 | -1,
  store: StoreSource = getArchiveStore,
): boolean {
  if (!isEnabled()) return false;
  const message = reaction.message;
  try {
    const byBot = user.id === reaction.client?.user?.id;
    return storeOf(store).updateReactions(message.id, (current) =>
      applyReactionDelta(current, reaction.emoji, delta, byBot),
    );
  } catch (error) {
    logger.warn(`archive: failed to update reactions of message ${message.id}:`, error);
    return false;
  }
}

/** MessageReactionRemoveAll: every reaction is gone. */
export function archiveReactionsCleared(
  message: Pick<ReactionMessageLike, 'id'>,
  store: StoreSource = getArchiveStore,
): boolean {
  if (!isEnabled()) return false;
  try {
    return storeOf(store).updateReactions(message.id, []);
  } catch (error) {
    logger.warn(`archive: failed to clear reactions of message ${message.id}:`, error);
    return false;
  }
}

/** MessageReactionRemoveEmoji: one emoji's reactions are gone (a moderator removed them all). */
export function archiveReactionEmojiCleared(
  reaction: Pick<ReactionEventLike, 'emoji' | 'message'>,
  store: StoreSource = getArchiveStore,
): boolean {
  if (!isEnabled()) return false;
  const key = reaction.emoji.id ?? reaction.emoji.name;
  if (!key) return false;
  try {
    return storeOf(store).updateReactions(reaction.message.id, (current) =>
      current.filter((r) => reactionKey(r) !== key),
    );
  } catch (error) {
    logger.warn(`archive: failed to clear an emoji's reactions on message ${reaction.message.id}:`, error);
    return false;
  }
}

const EMPTY_PROFILE: ReactionProfile = { messages: 0, reactedMessages: 0, baseRate: 0, emojis: [] };

/**
 * How the group reacts: for member messages in scope (a channel and its threads, and/or from `sinceMs`
 * on), each emoji's total uses (the bot's own reactions excluded), how many messages it was used on,
 * a few example messages, and the base rate of messages that get any reaction at all. An empty profile
 * when the archive is disabled or unavailable.
 */
export function getReactionProfile(
  opts: ReactionProfileOptions = {},
  store: StoreSource = getArchiveStore,
): ReactionProfile {
  if (!isEnabled()) return EMPTY_PROFILE;
  try {
    return storeOf(store).reactionProfile(opts);
  } catch (error) {
    logger.warn('archive: reaction profile query failed:', error);
    return EMPTY_PROFILE;
  }
}
