// Auto-transcripts: when a member posts a voice message (Discord's hold-to-record kind), the bot replies
// to it with the transcript, quietly — no ping, no notification — so people who can't listen right now
// can read it. The transcript lands in the cache on the way, which is what lets the chat agent, the
// learner and summaries "hear" the message later without paying again.
//
// Only real voice messages: an uploaded audio file (a song, a podcast clip) is not something the group
// wants lyrics posted for; the media enricher still transcribes those when the bot is asked about one.
// A voice message over VOICE_MAX_SECONDS gets a one-line "too long" note instead of silence.
import { ChannelType, type Message, MessageFlags, escapeMarkdown } from 'discord.js';
import { config } from '../../config';
import { logger } from '../../logger';
import { splitMessage } from '../../utils';
import { getAudioTranscriber } from './index';
import { forgetTranscripts, isStoredTranscriptReply, rememberTranscriptReply, transcriptRepliesTo } from './store';
import type { AudioInput, TranscriptionOutcome } from './types';
import { audioAttachments, formatClock, isVoiceMessage, transcriptKey } from './voice';

export const TRANSCRIPT_HEADER = '-# 🎙️ transcript';
export const TOO_LONG_HEADER = '-# 🎙️ too long to transcribe';

const MAX_AUDIO_PER_MESSAGE = 3;
// A 10-minute voice message (~1,500 words) runs ~4-5 messages; anything beyond that is cut.
const MAX_REPLY_CHUNKS = 5;
const WRAP_AT = 1800;
// Room kept in each 2000-character message for its header line ("-# 🎙️ transcript (5/5)").
const HEADER_ROOM = 40;

// Guild channels a member can post a voice message in and the bot can reply in.
const TRANSCRIBE_CHANNEL_TYPES: ReadonlySet<ChannelType> = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

/**
 * True for the bot's own transcript replies (and its "too long to transcribe" notes). Anything that
 * replays channel history to a model should skip these: the voice message they answer already carries
 * the transcript through the media enricher. And they are not the bot talking: a reply to one is a
 * reply to the voice message, not to the bot.
 *
 * By the header every transcript message opens with, else by the stored reply ids (continuations
 * posted before each message carried a header of its own). The header is what answers for the bot's own
 * MessageCreate: the id is stored only once the reply call returns, which can be after that event.
 */
export function isTranscriptReply(message: Message): boolean {
  if (message.author.id !== message.client.user?.id) return false;
  const content = message.content ?? '';
  if (content.startsWith(TRANSCRIPT_HEADER) || content.startsWith(TOO_LONG_HEADER)) return true;
  return isStoredTranscriptReply(message.id);
}

/**
 * isTranscriptReply() by id alone, for a reply whose target wasn't fetched: the ids of the transcript
 * replies the bot posted are kept in bot.db.
 */
export function isTranscriptReplyId(messageId: string): boolean {
  return isStoredTranscriptReply(messageId);
}

/**
 * Whether a message replies to one of the bot's transcript replies: by the stored id, else by the
 * replied-to message itself, which discord.js caches from the reply's payload (so an old transcript
 * whose id was pruned is still recognized without a fetch).
 */
export function repliesToTranscript(message: Message): boolean {
  const referencedId = message.reference?.messageId;
  if (!referencedId) return false;
  if (isTranscriptReplyId(referencedId)) return true;
  const cached = message.channel.messages.cache?.get(referencedId);
  return cached !== undefined && isTranscriptReply(cached);
}

/** The note posted instead of a transcript for a voice message over VOICE_MAX_SECONDS. */
export function formatTooLongNote(durationSecs: number): string {
  return `${TOO_LONG_HEADER} (${formatClock(durationSecs)})`;
}

function wrapLine(line: string): string[] {
  if (line.length <= WRAP_AT) return [line];
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > WRAP_AT) {
    const cut = rest.lastIndexOf(' ', WRAP_AT);
    const at = cut > WRAP_AT / 2 ? cut : WRAP_AT;
    pieces.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/**
 * The reply text, split into Discord-sized messages, each a subtext header ("(2/3)" when there are
 * several) then transcript lines as quotes. Every message carries the header: it is how
 * isTranscriptReply() tells each of them apart from the bot talking. Transcripts are escaped so a
 * spoken "*" or "# " can't turn into formatting.
 */
export function formatTranscriptReply(text: string): string[] {
  const quoted = text
    .split('\n')
    .map((line) =>
      escapeMarkdown(line.trim(), { heading: true, bulletedList: true, numberedList: true, maskedLink: true }),
    )
    .flatMap(wrapLine)
    .map((line) => (line.length > 0 ? `> ${line}` : '>'));
  let chunks = splitMessage(quoted.join('\n'), 2000 - HEADER_ROOM);
  if (chunks.length > MAX_REPLY_CHUNKS) {
    chunks = chunks.slice(0, MAX_REPLY_CHUNKS);
    chunks[MAX_REPLY_CHUNKS - 1] = `${chunks[MAX_REPLY_CHUNKS - 1].slice(0, 1900)}\n-# (transcript cut short)`;
  }
  return chunks.map((chunk, index) => {
    const header = chunks.length > 1 ? `${TRANSCRIPT_HEADER} (${index + 1}/${chunks.length})` : TRANSCRIPT_HEADER;
    return `${header}\n${chunk}`;
  });
}

export type VoiceAutoTranscriberOptions = {
  transcribe?: (input: AudioInput) => Promise<TranscriptionOutcome>;
  enabled?: () => boolean;
  channels?: () => string[];
};

export type AutoTranscriptResult = 'skipped' | 'posted' | 'nothing';

export class VoiceAutoTranscriber {
  private readonly transcribe: (input: AudioInput) => Promise<TranscriptionOutcome>;
  private readonly enabled: () => boolean;
  private readonly channels: () => string[];

  constructor(opts: VoiceAutoTranscriberOptions = {}) {
    this.transcribe = opts.transcribe ?? ((input) => getAudioTranscriber().transcribe(input));
    this.enabled = opts.enabled ?? (() => config.media.voiceAutoTranscribe);
    this.channels = opts.channels ?? (() => config.media.voiceTranscribeChannels);
  }

  async handle(message: Message): Promise<AutoTranscriptResult> {
    if (!this.enabled()) return 'skipped';
    // Members only: other bots' and webhooks' audio (including the bot's own reposts) is not ours to transcribe.
    if (message.author.bot || message.webhookId) return 'skipped';
    if (!TRANSCRIBE_CHANNEL_TYPES.has(message.channel.type)) return 'skipped';
    if (!this.channelAllowed(message)) return 'skipped';

    if (!isVoiceMessage(message)) return 'skipped';
    const audio = audioAttachments(message).slice(0, MAX_AUDIO_PER_MESSAGE);
    if (audio.length === 0) return 'skipped';

    let posted = false;
    for (const [index, attachment] of audio.entries()) {
      const outcome = await this.transcribe({
        url: attachment.url,
        contentType: attachment.contentType,
        messageId: transcriptKey(message.id, attachment.id, index),
        durationSecs: attachment.duration,
      });
      if (outcome.status === 'too_long') {
        // Silence would read as "the bot ignored it"; one line says why there's no transcript.
        if (await this.post(message, [formatTooLongNote(outcome.durationSecs)])) posted = true;
        continue;
      }
      if (outcome.status !== 'ok') {
        logger.info(`voiceTranscribe: no transcript for ${message.id} (${outcome.status})`);
        continue;
      }
      if (!outcome.text) continue;
      if (await this.post(message, formatTranscriptReply(outcome.text))) posted = true;
    }
    return posted ? 'posted' : 'nothing';
  }

  private channelAllowed(message: Message): boolean {
    const allowed = this.channels();
    if (allowed.length === 0) return true;
    const channel = message.channel;
    const parentId = 'parentId' in channel ? channel.parentId : null;
    return allowed.includes(channel.id) || (parentId !== null && allowed.includes(parentId));
  }

  private async post(message: Message, chunks: string[]): Promise<boolean> {
    try {
      for (const chunk of chunks) {
        const sent = await message.reply({
          content: chunk,
          // Never a ping — not for names said out loud, not for the member being replied to.
          allowedMentions: { parse: [], repliedUser: false },
          flags: MessageFlags.SuppressNotifications,
        });
        if (typeof sent?.id === 'string') rememberTranscriptReply(sent.id, message.id);
      }
      return true;
    } catch (error) {
      // Typically the voice message was deleted meanwhile, or the bot can't reply in this channel.
      logger.warn(`voiceTranscribe: could not post the transcript for ${message.id}:`, error);
      return false;
    }
  }
}

export const voiceAutoTranscriber = new VoiceAutoTranscriber();

/** Where deleted messages were: what removeTranscriptsOf needs to delete the bot's replies there. */
export type ReplyDeleter = { messages: { delete(messageId: string): Promise<unknown> } };

/**
 * A deleted voice message takes its transcript with it, the way the archive scrubs the message itself:
 * the bot's transcript replies to it are deleted (each of their deletions then scrubs them from the
 * archive) and the cached transcript text is forgotten. Returns how many replies were deleted.
 */
export async function removeTranscriptsOf(channel: ReplyDeleter, messageIds: string[]): Promise<number> {
  // A purge that took the replies along already deleted them.
  const replyIds = transcriptRepliesTo(messageIds).filter((id) => !messageIds.includes(id));
  forgetTranscripts(messageIds);
  let deleted = 0;
  for (const replyId of replyIds) {
    try {
      await channel.messages.delete(replyId);
      deleted++;
    } catch (error) {
      // Typically already deleted by hand.
      logger.warn(`voiceTranscribe: could not delete transcript reply ${replyId}:`, error);
    }
  }
  if (replyIds.length > 0) logger.info(`voiceTranscribe: voice message deleted, removed ${deleted} transcript replies`);
  return deleted;
}
