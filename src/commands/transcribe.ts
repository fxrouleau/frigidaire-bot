// "Transcribe": a transcript of the target's voice message or audio clip, and a description of any video
// attached to it, posted for everyone as a reply to the message. Transcripts the media pipeline already
// made (auto-transcribed voice messages) come from its cache for free. What can't be read for a known
// reason (over VOICE_MAX_SECONDS, over the download cap, today's video budget spent) gets the media
// feature's own note, shown to the invoker, instead of the generic failure line.
import { ApplicationCommandType, type Message } from 'discord.js';
import { videoOutcomeNote } from '../ai/media';
import { config } from '../config';
import { logger } from '../logger';
import { answerPrivately, blockQuote, deferPrivately, postPublicReply, subtext } from './respond';
import {
  type MediaAttachment,
  ensureTargetChannel,
  formatDuration,
  invokerName,
  mediaAttachments,
  readableText,
  resolveTargetAuthor,
  transcriptOf,
} from './targets';
import { type CommandDeps, CommandError, type MessageCommand } from './types';

// One message rarely carries more; the cap bounds paid work per click.
const MAX_MEDIA_PER_MESSAGE = 4;

export const TRANSCRIBE_LINES = {
  nothingThere: 'nothing to transcribe there, no voice message, audio or video on it',
  couldNot: "can't transcribe that one, sorry (too long, or my ears are busted right now)",
} as const;

export const transcribe: MessageCommand = {
  type: ApplicationCommandType.Message,
  name: 'Transcribe',
  exclusive: 'target',
  async run(interaction, deps) {
    const target = interaction.targetMessage;
    const media = mediaAttachments(target).slice(0, MAX_MEDIA_PER_MESSAGE);
    if (media.length === 0) throw new CommandError(TRANSCRIBE_LINES.nothingThere);

    await deferPrivately(interaction);
    await ensureTargetChannel(target);

    // Only a video description uses the author's name (as context for the model).
    const author = media.some((m) => m.kind === 'video')
      ? ((await resolveTargetAuthor(target))?.name ?? target.author.displayName)
      : target.author.displayName;
    const onlyAudio = media.filter((m) => m.kind === 'audio').length === 1;
    const results = await Promise.all(
      media.map(async (item) => ({ item, reading: await readMedia(target, item, author, deps, onlyAudio) })),
    );
    const readable = results.flatMap(({ item, reading }) =>
      reading && 'text' in reading ? [{ item, text: reading.text }] : [],
    );
    const notes = results.flatMap(({ item, reading }) =>
      reading && 'note' in reading ? [media.length > 1 ? `${labelFor(item)}: ${reading.note}` : reading.note] : [],
    );
    if (readable.length === 0) throw new CommandError(notes.length > 0 ? notes.join('\n') : TRANSCRIBE_LINES.couldNot);

    const labelled = readable.length > 1 || readable.some((r) => r.item.kind === 'video');
    const sections = readable.map(({ item, text }) =>
      labelled ? `**${labelFor(item)}**\n${blockQuote(text)}` : blockQuote(text),
    );
    const heading = readable.every((r) => r.item.kind === 'audio') ? 'transcript' : "what's in it";
    const body = `${subtext(`${heading} · asked by ${invokerName(interaction)}`)}\n${sections.join('\n')}`;

    const posted = await postPublicReply(target, body);
    await answerPrivately(interaction, [`posted it: ${posted.url}`, ...notes].join('\n'));
  },
};

/** What one attachment gave: its text, a note saying why there is none, or undefined (it just failed). */
type Reading = { text: string } | { note: string } | undefined;

async function readMedia(
  message: Message,
  item: MediaAttachment,
  author: string,
  deps: CommandDeps,
  onlyAudio: boolean,
): Promise<Reading> {
  if (item.kind === 'audio') {
    // The transcriber refuses these without a call; the attachment's duration says so up front.
    if (item.durationSecs && item.durationSecs > config.media.voiceMaxSeconds) {
      return { note: `too long to transcribe (${formatDuration(item.durationSecs)})` };
    }
    const transcript = await transcriptOf(message, item, deps, onlyAudio);
    return transcript ? { text: transcript } : undefined;
  }
  try {
    const text = readableText(message);
    const context = `Shared in a Discord chat by ${author}${text ? ` with the message: ${text}` : ''}`;
    const outcome = await deps.watchVideo({
      url: item.url,
      contentType: item.contentType,
      context,
      ...(item.durationSecs ? { durationSecs: item.durationSecs } : {}),
    });
    if (outcome.status === 'ok') return outcome.text.trim() ? { text: outcome.text.trim() } : undefined;
    // A spent budget or an oversized file is worth saying; a failed or unavailable watch is a plain failure.
    if (outcome.status === 'over_budget' || outcome.status === 'too_large') return { note: videoOutcomeNote(outcome) };
    return undefined;
  } catch (error) {
    logger.warn(`commands: describing ${item.name} on message ${message.id} failed:`, error);
    return undefined;
  }
}

function labelFor(item: MediaAttachment): string {
  const name = item.voice ? 'voice message' : item.name;
  return item.durationSecs ? `${name} (${formatDuration(item.durationSecs)})` : name;
}
