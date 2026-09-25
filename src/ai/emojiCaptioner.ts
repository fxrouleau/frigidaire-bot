import type OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';
import { getOpenRouterClient } from './openRouterClient';
import { emojiCdnUrl } from './promptSections';
import { featureRequestOptions } from './usage';

/**
 * Captions a single Discord custom emoji via a vision model over OpenRouter (EMOJI_CAPTION_MODEL,
 * Claude Opus by default — see config.ts for why). Returns the caption string, or undefined if the
 * captioning failed or OPENROUTER_API_KEY is unset. The caption is intentionally terse so it fits in
 * prompt preambles without blowing up token budgets.
 */
export async function captionEmoji(params: {
  id: string;
  name: string;
  animated: boolean;
  model?: string;
}): Promise<string | undefined> {
  const openai = getOpenRouterClient();
  if (!openai) {
    logger.warn(`emojiCaptioner: no OPENROUTER_API_KEY; skipping caption for ${params.name}`);
    return undefined;
  }

  const model = params.model ?? config.models.emojiCaption;
  const imageUrl = emojiCdnUrl(params.id, params.animated);

  logger.info(`emojiCaptioner: requesting caption for ${params.name} (${params.id}) via ${model}`);

  try {
    const response = await openai.chat.completions.create(
      {
        model,
        max_tokens: 160,
        temperature: 0.2,
        // @ts-expect-error OpenRouter-specific provider-routing hint — matches learner config
        provider: { zdr: true },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are captioning a Discord custom emoji for a chat bot's system prompt. The emoji's name is "${params.name}".

IMPORTANT: Most custom Discord emojis come from Twitch/streaming culture, anime fandoms, League of Legends, game-specific memes. The NAME usually carries more meaning than the image alone, because the cultural usage defines what the emote signals. Common families you should recognize by name:
- monkaS / monkaW / monkaX / monkaGIGA: panic, fear, nervousness, sweating through something
- pepega / Pepega: stupidity, foolishness — a mocking reaction
- POGGERS / PogChamp / Pog: hype, excitement, "let's go"
- OMEGALUL / LULW / LUL: extreme laughter
- FeelsGoodMan / FeelsBadMan / peepoHappy / peepoSad: Pepe content/sad/happy/crying
- AYAYA / FeelsKoroneMan: anime hype / otaku reactions
- 5Head / galaxybrain / Pepega (opposite): big-brain vs small-brain takes
- Kappa: sarcasm
- PauseChamp: anticipation / "wait for it"
- KEKW / KEK: laughter (generally)
- ratirl*: Rat IRL streamer family (varies wildly by variant — use image)
- Based / BasedCigar: cocky approval, "based"
- trolle / trollface: provocation, trolling

If the name matches a known emote family, use the CULTURAL meaning — do NOT default to generic "green frog with wide eyes" just because a lot of these use Pepe as a base. Different Pepes mean very different things.

If the name is original / server-specific / unclear, describe based on the image.

OUTPUT: one line, ≤80 characters, format "<brief visual>; for <emotion or situation>". No preamble, no quotes, no trailing period. Examples:
- "sweating Pepe, wide anxious eyes; for panic, shock, bad vibes"
- "smug content Pepe; for satisfaction, wholesome approval"
- "distorted laughing face; for extreme laughter"
- "Pepe with goofy grin; for stupidity, foolish takes"
- "hype wide-eyed face; for excitement, pog moments"

Now caption "${params.name}":`,
              },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
      },
      featureRequestOptions('emoji_caption'),
    );

    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) {
      logger.warn(`emojiCaptioner: empty response for ${params.name} (${params.id}) from ${model}`);
      return undefined;
    }

    // Strip wrapping quotes if the model added them despite instructions.
    return text.replace(/^["']|["']$/g, '').slice(0, 120);
  } catch (error) {
    logger.warn(`emojiCaptioner: failed to caption ${params.name} (${params.id}) via ${model}:`, error);
    return undefined;
  }
}

// ---- Usage-grounded captions ----
//
// The captions above describe an emoji's generic internet meaning, and the group's own usage often
// differs (a "sad" emoji used as resigned irony at absurd moments; a "thinking" one used for meh). The
// usage job (src/reactions/usageCaptions.ts) keeps the visual half of a caption and rewrites its
// "for …" half from real uses in the message archive, with the functions below.

/** Longest meaning half kept; the whole caption goes into every chat prompt's emoji glossary. */
const MAX_USAGE_CHARS = 80;

/** Splits "<visual>; for <meaning>" into its halves (a caption without a "for …" half is all visual). */
export function splitCaption(caption: string): { visual: string; meaning: string } {
  const trimmed = caption.trim();
  const forHalf = trimmed.match(/^(.*?);\s*(for\b.*)$/is);
  if (forHalf) return { visual: forHalf[1].trim(), meaning: forHalf[2].trim() };
  const semicolon = trimmed.indexOf(';');
  if (semicolon > 0) {
    return { visual: trimmed.slice(0, semicolon).trim(), meaning: trimmed.slice(semicolon + 1).trim() };
  }
  return { visual: trimmed, meaning: '' };
}

/** The caption with a new meaning half. */
export function composeCaption(visual: string, meaning: string): string {
  return visual ? `${visual}; ${meaning}` : meaning;
}

/**
 * The model's answer as a clean "for …" phrase, or undefined when there is nothing usable: first line
 * only, quotes and a trailing period dropped, emoji syntax removed, "for" enforced, clipped on a word.
 */
export function normalizeUsagePhrase(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let text = (raw.trim().split('\n')[0] ?? '')
    .replace(/<a?:(\w+):\d+>/g, '$1')
    .replace(/^[\s"'`*-]+|[\s"'`*.]+$/g, '')
    .replace(/;/g, ',')
    .trim();
  if (!text) return undefined;
  text = /^for\b/i.test(text) ? `for${text.slice(3)}` : `for ${text}`;
  if (text.length > MAX_USAGE_CHARS) {
    const cut = text.slice(0, MAX_USAGE_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    text = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).replace(/[\s,]+$/, '');
  }
  return text.length > 4 ? text : undefined;
}

export type UsagePhraseInput = {
  id: string;
  name: string;
  animated: boolean;
  /** The current caption (its meaning half is what gets replaced). */
  caption: string | null;
  /** Real uses, one prompt line each (see formatUsageSample in src/reactions/emojiUsage.ts). */
  uses: string[];
  /** The emoji's image; defaults to its Discord CDN URL. */
  imageUrl?: string;
  model?: string;
  /** Injected in tests; defaults to the shared OpenRouter client. */
  client?: OpenAI;
};

/**
 * Asks the caption model how THIS group uses an emoji, from real uses (and its image, so the answer stays
 * consistent with what it shows). Returns the new meaning half ("for …"), or undefined when the call
 * failed or produced nothing usable.
 */
export async function describeEmojiUsage(params: UsagePhraseInput): Promise<string | undefined> {
  const openai = params.client ?? getOpenRouterClient();
  if (!openai) return undefined;
  const model = params.model ?? config.models.emojiCaption;
  const current = params.caption ? `Its current caption is "${params.caption}".` : 'It has no caption yet.';
  try {
    const response = await openai.chat.completions.create(
      {
        model,
        max_tokens: 100,
        // @ts-expect-error OpenRouter-specific provider-routing hint (the uses are members' messages)
        provider: { zdr: true },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are grounding the caption of a Discord custom emoji in how one private friend group actually uses it. The emoji is "${params.name}" (image attached). ${current} Captions read "<visual>; for <meaning>": the visual half stays, you write the meaning half.

Below are real uses from this server: posts people reacted to with it, and messages it was typed in (with the message it was replying to when the emoji is most of the message). Work out what THIS group means by it. Groups often use an emoji differently from its generic internet meaning, e.g. a crying emoji used as a resigned "bruh" at absurd moments, or a thinking emoji used for meh, underwhelmed or mildly annoyed. Go by the uses rather than the name or the image; if the uses show no clear pattern, keep the current meaning.

Uses:
${params.uses.join('\n')}

OUTPUT: only the meaning half, one line starting with "for ", at most 70 characters, no quotes, no trailing period. Examples:
- for resigned "bruh" at absurd moments
- for meh, underwhelmed or mildly annoyed
- for big laughs at someone's expense`,
              },
              { type: 'image_url', image_url: { url: params.imageUrl ?? emojiCdnUrl(params.id, params.animated) } },
            ],
          },
        ],
      },
      featureRequestOptions('emoji_caption'),
    );
    const phrase = normalizeUsagePhrase(response.choices?.[0]?.message?.content);
    if (!phrase) logger.warn(`emojiCaptioner: ${model} gave no usable usage phrase for ${params.name}`);
    return phrase;
  } catch (error) {
    logger.warn(`emojiCaptioner: usage phrase for ${params.name} (${params.id}) via ${model} failed:`, error);
    return undefined;
  }
}
