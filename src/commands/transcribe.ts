// "Transcribe": a transcript of the target's voice message or audio clip, and a description of any video
// attached to it, posted for everyone as a reply to the message. Transcripts the media pipeline already
// made (auto-transcribed voice messages) come from its cache for free.
import { ApplicationCommandType, type Message } from 'discord.js';
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
      media.map(async (item) => ({ item, text: await readMedia(target, item, author, deps, onlyAudio) })),
    );
    const readable = results.filter((r): r is { item: MediaAttachment; text: string } => Boolean(r.text));
    if (readable.length === 0) throw new CommandError(TRANSCRIBE_LINES.couldNot);

    const labelled = readable.length > 1 || readable.some((r) => r.item.kind === 'video');
    const sections = readable.map(({ item, text }) =>
      labelled ? `**${labelFor(item)}**\n${blockQuote(text)}` : blockQuote(text),
    );
    const heading = readable.every((r) => r.item.kind === 'audio') ? 'transcript' : "what's in it";
    const body = `${subtext(`${heading} · asked by ${invokerName(interaction)}`)}\n${sections.join('\n')}`;

    const posted = await postPublicReply(target, body);
    await answerPrivately(interaction, `posted it: ${posted.url}`);
  },
};

async function readMedia(
  message: Message,
  item: MediaAttachment,
  author: string,
  deps: CommandDeps,
  onlyAudio: boolean,
): Promise<string | undefined> {
  if (item.kind === 'audio') return transcriptOf(message, item, deps, onlyAudio);
  try {
    const text = readableText(message);
    const context = `Shared in a Discord chat by ${author}${text ? ` with the message: ${text}` : ''}`;
    const description = await deps.describeVideo({ url: item.url, contentType: item.contentType, context });
    return description?.trim() || undefined;
  } catch (error) {
    logger.warn(`commands: describing ${item.name} on message ${message.id} failed:`, error);
    return undefined;
  }
}

function labelFor(item: MediaAttachment): string {
  const name = item.voice ? 'voice message' : item.name;
  return item.durationSecs ? `${name} (${formatDuration(item.durationSecs)})` : name;
}
