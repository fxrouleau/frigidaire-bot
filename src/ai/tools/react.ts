// react: add a reaction to the triggering message (lets a turn end without text).
//
// Reactions are how people in the server actually use its custom emojis, so this is the natural outlet
// for them; in-text custom emojis stay rare (see emojiPolicy.ts). The model names an emoji the way it
// knows it — a unicode character, a server emoji's name, or `<:name:id>` — and this resolves it against
// the server's emoji table before touching Discord, so a hallucinated emoji is a clear error, not a 400.
import { RESTJSONErrorCodes } from 'discord.js';
import { logger } from '../../logger';
import { getMemoryStore } from '../memory';
import type { EmojiRow } from '../memory/memoryStore';
import { emojiSyntax } from '../promptSections';
import type { ToolDefinition, ToolHandlerContext } from '../types';

export const MAX_REACTIONS_PER_TURN = 3;

const CUSTOM_EMOJI_TOKEN = /^<?(a?):(\w+):(\d+)>?$/;
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;

export type ResolvedEmoji =
  | { kind: 'unicode'; emoji: string; label: string }
  | { kind: 'custom'; emoji: string; label: string; row: EmojiRow };

function usableEmojis(): EmojiRow[] {
  try {
    return getMemoryStore().getUsableEmojis();
  } catch (error) {
    logger.warn('react: could not read the server emoji table:', error);
    return [];
  }
}

function custom(row: EmojiRow): ResolvedEmoji {
  // discord.js accepts `name:id` / `a:name:id` for a custom emoji reaction.
  return { kind: 'custom', emoji: `${row.animated ? 'a:' : ''}${row.name}:${row.id}`, label: emojiSyntax(row), row };
}

/**
 * Resolves what the model asked for to something Discord will accept, or undefined. Order: `<:name:id>`
 * syntax (the id must be a server emoji; an unknown id falls back to the name, since models misremember
 * ids), a single unicode emoji (a bare text-presentation symbol like ❤ gets its emoji variation
 * selector), then a server emoji name, case-insensitively, with optional surrounding colons.
 */
export function resolveReactionEmoji(input: string, emojis: EmojiRow[]): ResolvedEmoji | undefined {
  const raw = input.trim();
  if (raw.length === 0) return undefined;

  const token = raw.match(CUSTOM_EMOJI_TOKEN);
  if (token) {
    const byId = emojis.find((e) => e.id === token[3]);
    if (byId) return custom(byId);
    const byName = emojis.find((e) => e.name.toLowerCase() === token[2].toLowerCase());
    return byName ? custom(byName) : undefined;
  }

  if (RGI_EMOJI.test(raw)) return { kind: 'unicode', emoji: raw, label: raw };
  const qualified = `${raw}️`;
  if (RGI_EMOJI.test(qualified)) return { kind: 'unicode', emoji: qualified, label: qualified };

  const name = raw.replace(/^:|:$/g, '').toLowerCase();
  const byName = emojis.find((e) => e.name.toLowerCase() === name);
  return byName ? custom(byName) : undefined;
}

function unknownEmojiMessage(input: string, emojis: EmojiRow[]): string {
  const needle = input
    .trim()
    .replace(/^<?a?:|:\d*>?$/g, '')
    .toLowerCase();
  const similar = needle
    ? emojis
        .filter((e) => e.name.toLowerCase().includes(needle) || (e.caption ?? '').toLowerCase().includes(needle))
        .slice(0, 5)
        .map((e) => e.name)
    : [];
  const hint = similar.length > 0 ? ` Server emojis that might fit: ${similar.join(', ')}.` : '';
  return `Unknown emoji "${input}". Use a single unicode emoji (like 😂) or the exact name of one of this server's emojis.${hint}`;
}

function discordErrorCode(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

async function react(ctx: ToolHandlerContext, args: Record<string, unknown>): Promise<string> {
  const input = typeof args.emoji === 'string' ? args.emoji : '';
  if (ctx.turn.reactions.length >= MAX_REACTIONS_PER_TURN) {
    return `Not reacted: you already added ${MAX_REACTIONS_PER_TURN} reactions this turn, that's the limit.`;
  }

  const emojis = usableEmojis();
  const resolved = resolveReactionEmoji(input, emojis);
  if (!resolved) return unknownEmojiMessage(input, emojis);
  if (ctx.turn.reactions.includes(resolved.label)) return `Already reacted with ${resolved.label} this turn.`;

  try {
    await ctx.message.react(resolved.emoji);
  } catch (error) {
    const code = discordErrorCode(error);
    logger.warn(`react: adding ${resolved.label} in channel ${ctx.channelId} failed (code ${code ?? 'n/a'}):`, error);
    switch (code) {
      case RESTJSONErrorCodes.MissingPermissions:
      case RESTJSONErrorCodes.MissingAccess:
        return "Couldn't react: the bot is missing the Add Reactions permission in this channel. Answer in text instead.";
      case RESTJSONErrorCodes.UnknownEmoji:
        return unknownEmojiMessage(input, emojis);
      case RESTJSONErrorCodes.ReactionWasBlocked:
        return "Couldn't react: this person has blocked reactions from the bot. Answer in text instead.";
      case RESTJSONErrorCodes.MaximumNumberOfReactionsReached:
        return "Couldn't react: that message already has the maximum number of reactions. Answer in text instead.";
      case RESTJSONErrorCodes.UnknownMessage:
        return "Couldn't react: the message was deleted.";
      default:
        return "Couldn't react to that message (Discord error). Answer in text instead.";
    }
  }

  ctx.turn.reactions.push(resolved.label);
  return `Reacted with ${resolved.label}. If the reaction says it all, you can end your turn without any text.`;
}

const reactTool: ToolDefinition = {
  name: 'react',
  description:
    "Add an emoji reaction to the message you're answering. React when a reaction says it all: thanks, a lol, agreeing, a punchline landing. After reacting you may end your turn with no text at all. Questions and requests always still get a text answer. Accepts a unicode emoji (😂), a server emoji's name (reactions are the natural place for the server's custom emojis), or <:name:id>. At most 3 per turn.",
  parameters: {
    type: 'object',
    properties: {
      emoji: {
        type: 'string',
        description: 'One unicode emoji, or the name of a server custom emoji (e.g. "kekw").',
      },
    },
    required: ['emoji'],
    additionalProperties: false,
  },
  handler: react,
};

export const reactTools: ToolDefinition[] = [reactTool];
