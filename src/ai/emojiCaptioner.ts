import * as process from 'node:process';
import OpenAI from 'openai';
import { logger } from '../logger';

const DEFAULT_CAPTION_MODEL = 'qwen/qwen3-vl-235b-a22b-instruct';

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

  try {
    const response = await openai.chat.completions.create({
      model,
      max_tokens: 120,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Describe this Discord custom emoji named "${params.name}" in ≤70 characters.
Format: "<visual description>; for <emotion or situation it's used for>".
Be blunt and concrete. No preamble, no quotes, just the description.
Examples:
- green pickle Rick face; for absurdity or dismay
- troll face with raised eyebrow; for provocation or baiting
- smoking cigar meme; for cocky self-satisfaction`,
            },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    });

    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) return undefined;

    // Strip wrapping quotes if the model added them despite instructions.
    return text.replace(/^["']|["']$/g, '').slice(0, 120);
  } catch (error) {
    logger.warn(`emojiCaptioner: failed to caption ${params.name} (${params.id}):`, error);
    return undefined;
  }
}
