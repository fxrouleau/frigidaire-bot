// How the context-menu commands talk back.
//
// Every interaction response is ephemeral (only the invoker sees it). Output meant for the whole channel
// (a summary, a transcript) is posted as a regular message replying to the target instead of as the
// interaction's own response: Discord locks a response's visibility at deferReply() time, and the first
// follow-up after a deferral edits the "thinking…" placeholder and inherits that visibility — so a
// public deferral could never end in a private error message. With a private acknowledgement plus a
// channel reply, failures stay private and successes land right under the message they're about.
import { type CommandInteraction, type Message, MessageFlags } from 'discord.js';
import { logger } from '../logger';
import { splitMessage } from '../utils';
import { CommandError } from './types';

export const DISCORD_MESSAGE_LIMIT = 2000;
// Public output is capped so one oversized transcript or summary can't flood the channel.
const MAX_PUBLIC_CHUNKS = 4;
const MAX_PRIVATE_CHUNKS = 3;
const TRUNCATION_NOTE = '\n-# …cut off, too long to post';

// Discord error codes the commands translate into something a person can act on.
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

/** The in-character lines the commands answer with when things don't go to plan. */
export const LINES = {
  failed: 'ugh, that one broke on my end. try again in a bit',
  disabled: 'my right-click tricks are switched off right now',
  unknownCommand: "no clue what that button's supposed to do anymore",
  guildOnly: 'that only works in the server',
  noChannel: "can't see that channel from here",
  cannotPost: "I'm not allowed to post in here",
  busy: 'already on that one, give me a sec',
} as const;

/** No pings from anything the commands post: quoted chat text, names and model output can contain mentions. */
const NO_MENTIONS = { parse: [] } as const;

/** Acknowledges privately (the invoker sees "thinking…"). Must happen within Discord's 3-second window. */
export async function deferPrivately(interaction: CommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

/**
 * The private answer to the invoker, in whatever state the interaction is in: a fresh one gets an
 * ephemeral reply, a deferred or already-answered one has its response edited. Text longer than one
 * message continues in ephemeral follow-ups.
 */
export async function answerPrivately(interaction: CommandInteraction, text: string): Promise<void> {
  const [first, ...rest] = chunksFor(text, MAX_PRIVATE_CHUNKS);
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: first, allowedMentions: NO_MENTIONS });
  } else {
    await interaction.reply({ content: first, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
  }
  for (const chunk of rest) {
    await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
  }
}

/** answerPrivately() for failure paths: never throws (an expired token or a Discord outage is only logged). */
export async function failPrivately(interaction: CommandInteraction, text: string): Promise<void> {
  try {
    await answerPrivately(interaction, text);
  } catch (error) {
    logger.warn(`commands: could not deliver the failure message for "${interaction.commandName}":`, error);
  }
}

/**
 * Posts `text` in the target's channel as a reply to the target (no pings, not even the replied-to
 * author), continuing in plain messages when it needs more than one. Falls back to a plain post when
 * the reply itself is refused (system messages can't be replied to; replies need Read Message History).
 * Returns the first posted message. A channel the bot may not post in becomes a CommandError.
 */
export async function postPublicReply(target: Message, text: string): Promise<Message> {
  const [first, ...rest] = chunksFor(text, MAX_PUBLIC_CHUNKS);
  let posted: Message;
  try {
    posted = await target.reply({ content: first, allowedMentions: { ...NO_MENTIONS, repliedUser: false } });
  } catch (error) {
    logger.warn(`commands: replying to message ${target.id} failed, posting without the reply:`, error);
    posted = await sendToChannel(target, first);
  }
  for (const chunk of rest) {
    await sendToChannel(target, chunk);
  }
  return posted;
}

async function sendToChannel(target: Message, content: string): Promise<Message> {
  const channel = target.channel;
  if (!channel || !('send' in channel)) throw new CommandError(LINES.cannotPost);
  try {
    return await channel.send({ content, allowedMentions: NO_MENTIONS });
  } catch (error) {
    const code = discordErrorCode(error);
    if (code === MISSING_ACCESS || code === MISSING_PERMISSIONS) throw new CommandError(LINES.cannotPost);
    throw error;
  }
}

/** The numeric Discord API error code of a failed REST call, if it is one. */
export function discordErrorCode(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'number') return error.code;
  return undefined;
}

/** Splits into message-sized chunks, keeping at most `maxChunks` and marking the cut. */
export function chunksFor(text: string, maxChunks: number): string[] {
  const chunks = splitMessage(text.length > 0 ? text : '(empty)', DISCORD_MESSAGE_LIMIT);
  if (chunks.length <= maxChunks) return chunks;
  const kept = chunks.slice(0, maxChunks);
  const last = kept[maxChunks - 1];
  kept[maxChunks - 1] = `${last.slice(0, DISCORD_MESSAGE_LIMIT - TRUNCATION_NOTE.length)}${TRUNCATION_NOTE}`;
  return kept;
}

/**
 * Renders text as a Discord block quote. Long lines (a transcript is often one giant paragraph) are
 * wrapped at word boundaries first, so splitting into 2000-character messages never cuts a word in half
 * or leaves a continuation outside the quote.
 */
export function blockQuote(text: string, maxLineLength = 1800): string {
  return text
    .trim()
    .split('\n')
    .flatMap((line) => wrapLine(line, maxLineLength))
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

function wrapLine(line: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > max) {
    const breakAt = rest.lastIndexOf(' ', max);
    const cut = breakAt > max / 2 ? breakAt : max;
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  pieces.push(rest);
  return pieces;
}

/** Discord's small grey "subtext" line. */
export function subtext(text: string): string {
  return `-# ${text}`;
}
