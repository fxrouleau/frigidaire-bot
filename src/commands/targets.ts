// Reading the message or member a context-menu command was used on: who really wrote it (link-fix
// reposts are webhook messages posted on a member's behalf), their current server name, which of its
// attachments are audio/video, and the text a model should see.
import {
  type APIInteractionGuildMember,
  type Guild,
  type GuildMember,
  type Message,
  MessageFlags,
  escapeMarkdown,
} from 'discord.js';
import { logger } from '../logger';
import { attributeMessage } from '../relay';
import { LINES } from './respond';
import { type CommandDeps, CommandError } from './types';

/**
 * Makes sure `message.channel` resolves. It is a lookup in the client's channel cache, and a command's
 * target can live in a channel the cache doesn't hold (e.g. an archived thread); fetching caches it.
 */
export async function ensureTargetChannel(message: Message): Promise<void> {
  if (message.channel) return;
  try {
    await message.client.channels.fetch(message.channelId);
  } catch (error) {
    logger.warn(`commands: could not fetch channel ${message.channelId}:`, error);
  }
  if (!message.channel) throw new CommandError(LINES.noChannel);
}

/** A member's current server display name, from the cache or one REST fetch. Undefined when they're not in the server. */
export async function liveDisplayName(guild: Guild | null, userId: string): Promise<string | undefined> {
  if (!guild) return undefined;
  try {
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId));
    return member.displayName;
  } catch (error) {
    // Unknown Member (left the server) is expected; anything else is worth a line in the log.
    logger.info(`commands: no member ${userId} in ${guild.name}:`, error instanceof Error ? error.message : error);
    return undefined;
  }
}

export type TargetAuthor = {
  /** Discord user id of the real author; undefined for an old relay only known by name. */
  id?: string;
  /** Their current server display name. */
  name: string;
};

/**
 * The person a message should be attributed to (the real author of a relayed repost), with their live
 * server display name. Undefined for bots and other integrations' webhooks.
 */
export async function resolveTargetAuthor(message: Message): Promise<TargetAuthor | undefined> {
  const attribution = attributeMessage(message);
  if (!attribution) return undefined;
  if (!attribution.authorId) return { name: attribution.authorName };
  const name = await liveDisplayName(message.guild, attribution.authorId);
  return { id: attribution.authorId, name: name ?? attribution.authorName };
}

/** The display name to credit the invoker with in posts (markdown-escaped: it goes straight into message text). */
export function invokerName(interaction: {
  member: GuildMember | APIInteractionGuildMember | null;
  user: { displayName: string };
}): string {
  const member = interaction.member;
  const name = member && 'displayName' in member ? member.displayName : member?.nick || interaction.user.displayName;
  return escapeMarkdown(name);
}

export type MediaAttachment = {
  kind: 'audio' | 'video';
  url: string;
  name: string;
  contentType: string | null;
  durationSecs: number | null;
  /** A Discord voice message (recorded in the app) rather than an uploaded file. */
  voice: boolean;
};

const AUDIO_EXTENSION = /\.(ogg|oga|opus|mp3|m4a|wav|flac|aac|wma)$/i;
const VIDEO_EXTENSION = /\.(mp4|mov|webm|mkv|avi|m4v)$/i;

/** The audio and video attachments of a message, in order. Voice messages are always audio. */
export function mediaAttachments(message: Message): MediaAttachment[] {
  const voiceMessage = message.flags.has(MessageFlags.IsVoiceMessage);
  const found: MediaAttachment[] = [];
  for (const attachment of message.attachments.values()) {
    const type = attachment.contentType?.split(';')[0].trim().toLowerCase() ?? '';
    const name = attachment.name ?? '';
    let kind: MediaAttachment['kind'] | undefined;
    if (type.startsWith('audio/') || (voiceMessage && !type.startsWith('video/'))) kind = 'audio';
    else if (type.startsWith('video/')) kind = 'video';
    else if (!type && AUDIO_EXTENSION.test(name)) kind = 'audio';
    else if (!type && VIDEO_EXTENSION.test(name)) kind = 'video';
    if (!kind) continue;
    found.push({
      kind,
      url: attachment.url,
      name: name || (kind === 'audio' ? 'audio' : 'video'),
      contentType: attachment.contentType,
      durationSecs: attachment.duration ?? null,
      voice: voiceMessage && kind === 'audio',
    });
  }
  return found;
}

/**
 * A transcript of one audio attachment: the cached one when the media pipeline already made it
 * (free), otherwise a fresh transcription. The cache is keyed by message id, so it is only used when
 * the message has exactly one audio attachment. Failures are logged and read as "no transcript".
 */
export async function transcriptOf(
  message: Message,
  audio: MediaAttachment,
  deps: Pick<CommandDeps, 'transcribeAudio' | 'getCachedTranscript'>,
  onlyAudioOnMessage: boolean,
): Promise<string | undefined> {
  try {
    if (onlyAudioOnMessage) {
      const cached = deps.getCachedTranscript(message.id);
      if (cached?.trim()) return cached.trim();
    }
    const transcript = await deps.transcribeAudio({
      url: audio.url,
      contentType: audio.contentType,
      messageId: onlyAudioOnMessage ? message.id : undefined,
      durationSecs: audio.durationSecs,
    });
    return transcript?.trim() || undefined;
  } catch (error) {
    logger.warn(`commands: transcribing ${audio.name} on message ${message.id} failed:`, error);
    return undefined;
  }
}

/** The transcript of a message's voice message / audio clip, if it has exactly one audio attachment worth reading. */
export async function voiceTranscriptOf(
  message: Message,
  deps: Pick<CommandDeps, 'transcribeAudio' | 'getCachedTranscript'>,
): Promise<string | undefined> {
  const audio = mediaAttachments(message).filter((m) => m.kind === 'audio');
  if (audio.length === 0) return undefined;
  return transcriptOf(message, audio[0], deps, audio.length === 1);
}

/** The message's own text with mentions rendered as names (never raw `<@id>` tokens). */
export function readableText(message: Message): string {
  return (message.cleanContent ?? message.content ?? '').trim();
}

/** "1:05" for 65 seconds. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
