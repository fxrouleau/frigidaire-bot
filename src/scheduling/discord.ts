// Small Discord helpers shared by the scheduled posts (reminders, birthdays) and the poll tool.
import {
  ChannelType,
  type Client,
  type Message,
  type MessageCreateOptions,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
} from 'discord.js';

/** A channel the bot can post in. Structural so the scheduler works with any sendable channel (and fakes). */
export type PostableChannel = {
  id: string;
  send(options: MessageCreateOptions): Promise<{ id: string }>;
};

/** Discord's JSON error code on a failed REST call (DiscordAPIError.code), when there is one. */
export function discordErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

// Errors that retrying the same channel will not fix: the channel is gone, the bot can't see or post
// in it, or it is a locked/archived thread.
const PERMANENT_CHANNEL_ERRORS: ReadonlySet<number> = new Set([
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.MissingAccess,
  RESTJSONErrorCodes.MissingPermissions,
  RESTJSONErrorCodes.CannotSendMessagesInNonTextChannel,
  RESTJSONErrorCodes.InvalidActionOnArchivedThread,
  RESTJSONErrorCodes.ThreadLocked,
]);

export function isPermanentChannelError(error: unknown): boolean {
  const code = discordErrorCode(error);
  return code !== undefined && PERMANENT_CHANNEL_ERRORS.has(code);
}

/** Thrown by fetchPostableChannel when the id resolves to something the bot cannot post in. */
export class UnpostableChannelError extends Error {
  readonly code = RESTJSONErrorCodes.CannotSendMessagesInNonTextChannel;
}

/** Fetches a channel and checks that it can take a message; throws (a Discord or Unpostable error) otherwise. */
export async function fetchPostableChannel(client: Client, channelId: string): Promise<PostableChannel> {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || !('send' in channel)) {
    throw new UnpostableChannelError(`Channel ${channelId} is missing or not text-based.`);
  }
  return channel as unknown as PostableChannel;
}

/**
 * True only when every member of the server can read the channel: @everyone may view it (for a thread,
 * its parent) and it is not a private thread. DMs, restricted channels, and anything that can't be
 * checked count as not visible — the safe answer for "may this text be reposted in the main channel?".
 */
export function isVisibleToEveryone(channel: Message['channel']): boolean {
  try {
    if (channel.isDMBased()) return false;
    if (channel.type === ChannelType.PrivateThread) return false;
    return channel.permissionsFor(channel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) === true;
  } catch {
    return false;
  }
}

/** The message's jump link (what discord.js' `message.url` returns), built from ids so it never throws. */
export function jumpLink(message: Pick<Message, 'id' | 'guildId' | 'channel'>): string {
  return `https://discord.com/channels/${message.guildId ?? '@me'}/${message.channel.id}/${message.id}`;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
