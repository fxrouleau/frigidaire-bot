import { config } from '../config';
import { logger } from '../logger';
import { getOpenRouterClient } from './openRouterClient';
import { emojiCdnUrl } from './promptSections';

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
