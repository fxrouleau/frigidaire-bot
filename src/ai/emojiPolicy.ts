// Deterministic guardrail on custom-emoji use in the bot's replies. The prompt asks for restraint,
// but the strongest signal in the model's context is its own earlier emoji-laden replies (seeded
// back from channel history), so a rule the model can't argue with is what actually sets the rate.
//
// Policy: at most ONE custom emoji per reply, only when the reply is a pure reaction (emoji-only),
// the triggering message itself contained a custom emoji (mirroring is natural), or none of the
// bot's recent replies in this window used one. Emojis the server doesn't have are always removed —
// Discord can't render them anyway, they show up as raw `<:name:id>` text.
import { findCustomEmojis } from './promptSections';

const CUSTOM_EMOJI_TOKEN = /<a?:\w+:\d+>/g;

export type EmojiPolicyContext = {
  /** The user's triggering message contained a custom emoji. */
  userMessageHadEmoji: boolean;
  /** How many of the bot's recent replies in this conversation window contained a custom emoji. */
  recentBotEmojiReplies: number;
  /** Ids of the server's usable custom emojis; undefined when unknown (then no id check is applied). */
  knownIds?: ReadonlySet<string>;
};

export type EmojiPolicyResult = { text: string; kept: string[]; stripped: string[] };

/** True when the text contains at least one custom emoji token. */
export function hasCustomEmoji(text: string): boolean {
  return findCustomEmojis(text).length > 0;
}

export function applyEmojiPolicy(reply: string, ctx: EmojiPolicyContext): EmojiPolicyResult {
  const tokens = findCustomEmojis(reply);
  if (tokens.length === 0) return { text: reply, kept: [], stripped: [] };

  const withoutEmojis = reply.replace(CUSTOM_EMOJI_TOKEN, '').trim();
  const emojiOnly = withoutEmojis.length === 0;
  const allowOne = emojiOnly || ctx.userMessageHadEmoji || ctx.recentBotEmojiReplies === 0;

  const kept: string[] = [];
  const stripped: string[] = [];
  const text = reply
    .replace(CUSTOM_EMOJI_TOKEN, (token) => {
      const id = token.match(/\d+/)?.[0] ?? '';
      const known = ctx.knownIds ? ctx.knownIds.has(id) : true;
      if (allowOne && known && kept.length === 0) {
        kept.push(token);
        return token;
      }
      stripped.push(token);
      return '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,!?;:])/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .trim();

  // Never turn a reply into nothing: a reply that was only unrenderable emojis goes out as-is.
  if (text.length === 0) return { text: reply, kept: tokens.map((t) => t.name), stripped: [] };

  return { text, kept, stripped };
}
