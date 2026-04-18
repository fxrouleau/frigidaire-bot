import * as process from 'node:process';
import OpenAI from 'openai';
import { logger } from '../logger';

// Opus over Qwen here because Qwen3-VL, despite being a strong generalist vision model,
// had no grasp of Twitch/meme-emote culture — it just kept describing every Pepe variant
// as "green frog with wide eyes" regardless of whether it was monkaW, pepega, or FeelsGoodMan.
// The captions are one-shot per emoji and cached forever, so paying Opus rates here is pennies.
const DEFAULT_CAPTION_MODEL = 'anthropic/claude-opus-4.7';

let cachedClient: OpenAI | undefined;

function getClient(): OpenAI | undefined {
  if (!process.env.OPENROUTER_API_KEY) return undefined;
  if (!cachedClient) {
    cachedClient = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: { 'X-Title': 'Frigidaire Bot' },
    });
  }
  return cachedClient;
}

export function emojiCdnUrl(emojiId: string, animated: boolean): string {
  const ext = animated ? 'gif' : 'png';
  return `https://cdn.discordapp.com/emojis/${emojiId}.${ext}?size=96&quality=lossless`;
}

/**
 * Captions a single Discord custom emoji via Qwen3-VL over OpenRouter.
 * Returns the caption string, or undefined if the captioning failed or the
 * OPENROUTER_API_KEY is unset. The caption is intentionally terse so it fits in
 * prompt preambles without blowing up token budgets.
 */
export async function captionEmoji(params: {
  id: string;
  name: string;
  animated: boolean;
  model?: string;
}): Promise<string | undefined> {
  const openai = getClient();
  if (!openai) {
    logger.warn(`emojiCaptioner: no OPENROUTER_API_KEY; skipping caption for ${params.name}`);
    return undefined;
  }

  const model = params.model ?? process.env.EMOJI_CAPTION_MODEL ?? DEFAULT_CAPTION_MODEL;
  const imageUrl = emojiCdnUrl(params.id, params.animated);

  logger.info(`emojiCaptioner: requesting caption for ${params.name} (${params.id}) via ${model}`);

  try {
    const response = await openai.chat.completions.create({
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
    });

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
