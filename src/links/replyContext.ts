// Webhooks can't create replies, so a reposted reply would lose what it was answering. The repost
// carries a Discord subtext line instead: `-# ↪ replying to <Name> · <jump link>`.
import { type Message, MessageReferenceType, escapeMarkdown, messageLink } from 'discord.js';
import { logger } from '../logger';

const REFERENCE_FETCH_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Who the message replies to, resolved cheaply: the gateway already sends the replied-to author
 * (`mentions.repliedUser`, present whether or not the reply pinged), with the server nickname from the
 * member cache. Only when that is missing is the referenced message fetched (normally a cache hit,
 * time-boxed either way).
 */
async function repliedAuthorName(message: Message, timeoutMs: number): Promise<string | undefined> {
  const user = message.mentions.repliedUser;
  if (user) {
    return message.guild?.members.cache.get(user.id)?.displayName ?? user.displayName ?? user.username;
  }
  try {
    const referenced = await withTimeout(message.fetchReference(), timeoutMs);
    if (!referenced) return undefined;
    return referenced.member?.displayName ?? referenced.author.displayName;
  } catch (error) {
    // The replied-to message was deleted, or the channel isn't readable: the jump link alone will do.
    logger.info(`linkfix: could not resolve the message ${message.id} replies to:`, error);
    return undefined;
  }
}

/** The subtext line for a reply, or undefined when the message isn't a reply (forwards aren't). */
export async function replyContextLine(
  message: Message,
  timeoutMs = REFERENCE_FETCH_TIMEOUT_MS,
): Promise<string | undefined> {
  const reference = message.reference;
  if (!reference?.messageId || reference.type === MessageReferenceType.Forward) return undefined;

  const guildId = reference.guildId ?? message.guildId ?? undefined;
  const link = guildId
    ? messageLink(reference.channelId, reference.messageId, guildId)
    : messageLink(reference.channelId, reference.messageId);
  const name = await repliedAuthorName(message, timeoutMs);
  return name ? `-# ↪ replying to ${escapeMarkdown(name)} · ${link}` : `-# ↪ replying to ${link}`;
}
