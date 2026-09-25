// Auto-transcripts: when a member posts a voice message (or an audio file), the bot replies to it with
// the transcript, quietly — no ping, no notification — so people who can't listen right now can read
// it. The transcript lands in the cache on the way, which is what lets the chat agent, the learner and
// summaries "hear" the message later without paying again.
import { ChannelType, type Message, MessageFlags, escapeMarkdown } from 'discord.js';
import { config } from '../../config';
import { logger } from '../../logger';
import { splitMessage } from '../../utils';
import { getAudioTranscriber } from './index';
import type { AudioInput, TranscriptionOutcome } from './types';
import { audioAttachments, isVoiceMessage, transcriptKey } from './voice';

export const TRANSCRIPT_HEADER = '-# 🎙️ transcript';

const MAX_AUDIO_PER_MESSAGE = 3;
// A 10-minute voice message with its translation runs ~4 messages; anything beyond that is cut.
const MAX_REPLY_CHUNKS = 5;
const WRAP_AT = 1800;

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
 * True for the bot's own transcript replies. Anything that replays channel history to a model should
 * skip these: the voice message they answer already carries the transcript through the media enricher.
 */
export function isTranscriptReply(message: Message): boolean {
  return message.author.id === message.client.user?.id && (message.content ?? '').startsWith(TRANSCRIPT_HEADER);
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
 * The reply text, split into Discord-sized messages: a subtext header, then every transcript line as
 * a quote. Transcripts are escaped so a spoken "*" or "# " can't turn into formatting.
 */
export function formatTranscriptReply(text: string, label?: string): string[] {
  const header = label ? `${TRANSCRIPT_HEADER} · ${escapeMarkdown(label)}` : TRANSCRIPT_HEADER;
  const quoted = text
    .split('\n')
    .map((line) =>
      escapeMarkdown(line.trim(), { heading: true, bulletedList: true, numberedList: true, maskedLink: true }),
    )
    .flatMap(wrapLine)
    .map((line) => (line.length > 0 ? `> ${line}` : '>'));
  const chunks = splitMessage([header, ...quoted].join('\n'), 2000);
  if (chunks.length <= MAX_REPLY_CHUNKS) return chunks;
  const kept = chunks.slice(0, MAX_REPLY_CHUNKS);
  kept[MAX_REPLY_CHUNKS - 1] = `${kept[MAX_REPLY_CHUNKS - 1].slice(0, 1900)}\n-# (transcript cut short)`;
  return kept;
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

    const audio = audioAttachments(message).slice(0, MAX_AUDIO_PER_MESSAGE);
    if (audio.length === 0) return 'skipped';

    const voice = isVoiceMessage(message);
    let posted = false;
    for (const [index, attachment] of audio.entries()) {
      const outcome = await this.transcribe({
        url: attachment.url,
        contentType: attachment.contentType,
        messageId: transcriptKey(message.id, attachment.id, index),
        durationSecs: attachment.duration,
      });
      if (outcome.status !== 'ok') {
        logger.info(`voiceTranscribe: no transcript for ${message.id} (${outcome.status})`);
        continue;
      }
      if (!outcome.text) continue;
      const label = voice ? undefined : attachment.name;
      if (await this.post(message, formatTranscriptReply(outcome.text, label))) posted = true;
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
        await message.reply({
          content: chunk,
          // Never a ping — not for names said out loud, not for the member being replied to.
          allowedMentions: { parse: [], repliedUser: false },
          flags: MessageFlags.SuppressNotifications,
        });
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
