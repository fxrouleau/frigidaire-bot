// "Is this message addressed to the bot?" — the question behind replying without an @-mention.
//
// A TypeSafe decision model answers it with a calibrated probability (one Noul question over a small
// JSON state). This module owns that state and question, built from plain data (AddressedInput) so the
// live gate (addressedGate.ts) and the offline eval (eval/) send exactly the same thing.
//
// Question design follows TypeSafe's jev-1.13 guidance: the state carries only what the decision needs
// (the latest message, a few messages of context, who the bot was talking to), time arrives as words
// rather than numbers, fields are referenced by name, and the boundary cases live in the criteria.
import { config } from '../config';
import { type DecisionsOptions, type NoulQuestion, askNoul } from '../ai/decisions';
import type { UsageFeature } from '../ai/usage';
import { describeBotLastSpoke, truncate } from './text';

const CONTEXT_TEXT_MAX = 300;
const MESSAGE_TEXT_MAX = 600;

export type ChatLine = {
  author: string;
  text: string;
  /** 'self' = this bot; 'other_bot' = another bot or integration; omitted = a person. */
  kind?: 'self' | 'other_bot';
  /** Who this message is a Discord reply to, when it is one. */
  replyTo?: string;
};

export type AddressedInput = {
  botName: string;
  /** What people call the bot besides its name (the gate's name list). */
  nicknames: string[];
  message: { author: string; text: string; replyTo?: string };
  /** The messages right before `message`, oldest first. */
  context: ChatLine[];
  /** Seconds from the bot's last message in the channel to `message`; undefined = not recently / unknown. */
  secondsSinceBotSpoke?: number;
  /** Whether the author of `message` is who the bot was last talking with in the channel. */
  authorIsBotsPartner: boolean;
};

/** Resolves to the probability that the message is addressed to the bot, or undefined when unanswerable. */
export type AddressedClassifier = (input: AddressedInput) => Promise<number | undefined>;

function authorLabel(line: ChatLine, botName: string): string {
  if (line.kind === 'self') return `${botName} (the bot)`;
  if (line.kind === 'other_bot') return `${line.author} (a different bot, not ${botName})`;
  return line.author;
}

export function buildAddressedState(input: AddressedInput): Record<string, unknown> {
  const nicknames = input.nicknames.filter((n) => n.toLowerCase() !== input.botName.toLowerCase());
  return {
    bot: `${input.botName}, an AI bot that hangs out in this friend group's Discord chat as one of the group.${
      nicknames.length > 0 ? ` People also call it: ${nicknames.join(', ')}.` : ''
    }`,
    recent_chat: input.context.map((line) => ({
      author: authorLabel(line, input.botName),
      text: truncate(line.text, CONTEXT_TEXT_MAX),
      ...(line.replyTo ? { replying_to: line.replyTo } : {}),
    })),
    latest_message: {
      author: input.message.author,
      text: truncate(input.message.text, MESSAGE_TEXT_MAX),
      ...(input.message.replyTo ? { replying_to: input.message.replyTo } : {}),
    },
    bot_last_spoke: describeBotLastSpoke(input.secondsSinceBotSpoke),
    bot_was_just_talking_with_this_author: input.authorIsBotsPartner ? 'yes' : 'no',
  };
}

export const ADDRESSED_QUESTION: NoulQuestion = {
  type: 'noul',
  instructions:
    'Is `latest_message` addressed to the bot described in `bot`: is its author talking TO the bot (not just about it) and expecting the bot to respond?',
  criteria: {
    true: [
      "The author talks to the bot directly by its name or a nickname, e.g. 'fridge what do you think', 'yo frigidaire', 'bot, settle this', 'clanker shut up'. Insults count when they are aimed at the bot itself.",
      'The author asks the bot a question or tells it to do something.',
      "The bot spoke moments ago (`bot_last_spoke`) in a conversation with this author (`bot_was_just_talking_with_this_author` is yes), and `latest_message` answers the bot, pushes back on what it said, or asks it a follow-up, even without naming it or using Discord's reply.",
    ],
    false: [
      "The author talks ABOUT the bot to other people, in the third person: 'the bot is cooked today', 'fridge is so mean to me', 'someone ask fridge'.",
      "'fridge' means a refrigerator: 'the beer is in the fridge'.",
      "'bot' is gaming or everyday slang, or means a different bot: bot lane, the ADC/support duo, AI bots in a game, calling a player a bot.",
      'The message is addressed to another person in the chat.',
      "The author only laughs at or reacts to the bot's last message ('LMAOOO', 'true', 'ok', 'screenshotting this') without asking or telling it anything.",
    ],
  },
};

export type AddressedClassifierOptions = Pick<DecisionsOptions, 'fetch' | 'apiKey' | 'timeoutMs' | 'onUsage'> & {
  model?: string;
  /** Usage attribution; the eval runner passes 'eval'. */
  feature?: UsageFeature;
};

export function createAddressedClassifier(opts: AddressedClassifierOptions = {}): AddressedClassifier {
  return (input) =>
    askNoul(opts.model ?? config.gate.model, buildAddressedState(input), ADDRESSED_QUESTION, {
      feature: opts.feature ?? 'gate',
      fetch: opts.fetch,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      onUsage: opts.onUsage,
    });
}
