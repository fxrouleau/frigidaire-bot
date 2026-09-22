import { AttachmentBuilder, type Message } from 'discord.js';
import type OpenAI from 'openai';
import { config } from '../../config';
import { logger } from '../../logger';
import { requireOpenRouterClient } from '../openRouterClient';
import type { ImageGenerationOptions } from '../types';

type ImageConversationMessage = {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
};

type ImageSession = {
  conversationHistory: ImageConversationMessage[];
  createdAt: number;
};

const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
// Every refinement re-sends the whole history, and each assistant turn carries a full base64 image,
// so the history is capped to the last few exchanges (a "refine" only needs the latest image anyway).
const MAX_SESSION_MESSAGES = 6;
const sessions = new Map<string, ImageSession>();

function getSession(channelId: string): ImageSession | undefined {
  const session = sessions.get(channelId);
  if (!session) return undefined;
  if (Date.now() - session.createdAt > SESSION_TIMEOUT) {
    sessions.delete(channelId);
    return undefined;
  }
  return session;
}

function setSession(channelId: string, history: ImageConversationMessage[]): void {
  // Sweep other channels' expired sessions here too, so an idle channel's base64 blobs don't linger.
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TIMEOUT) sessions.delete(id);
  }
  sessions.set(channelId, { conversationHistory: history.slice(-MAX_SESSION_MESSAGES), createdAt: now });
}

export function extractImageFromResponse(
  response: OpenAI.ChatCompletion,
): { base64: string; text?: string } | undefined {
  const message = response.choices[0]?.message;
  if (!message) return undefined;

  // Check for images in content array (OpenRouter content block format)
  const content = message.content;
  if (typeof content === 'string') {
    // Check if it's a base64 data URL
    const dataUrlMatch = content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
    if (dataUrlMatch) {
      return { base64: dataUrlMatch[1] };
    }
  }

  // Check extended response fields that OpenRouter might use
  const extended = message as unknown as Record<string, unknown>;

  // Images might be in a custom `images` field
  if (Array.isArray(extended.images) && extended.images.length > 0) {
    const img = extended.images[0] as string;
    // Could be a data URL or raw base64
    const stripped = img.replace(/^data:image\/[^;]+;base64,/, '');
    return { base64: stripped, text: typeof content === 'string' ? content : undefined };
  }

  // Images might be in content blocks
  if (Array.isArray(extended.content)) {
    for (const block of extended.content as Array<Record<string, unknown>>) {
      if (block.type === 'image_url' && typeof block.image_url === 'object' && block.image_url !== null) {
        const urlObj = block.image_url as { url?: string };
        if (urlObj.url) {
          const stripped = urlObj.url.replace(/^data:image\/[^;]+;base64,/, '');
          return { base64: stripped };
        }
      }
      if (block.type === 'image' && typeof block.data === 'string') {
        return { base64: block.data };
      }
    }
  }

  return undefined;
}

export async function generateLocalImage(
  message: Message,
  prompt: string,
  options?: ImageGenerationOptions,
): Promise<string> {
  try {
    const shouldRefine = options?.refinePrevious ?? false;
    const sourceImageUrl = options?.sourceImageUrl;
    const channelId = message.channel.id;
    const session = getSession(channelId);

    if (shouldRefine && !session) {
      return 'I could not find a previous image to refine for this channel.';
    }

    if (message.channel.isTextBased() && 'sendTyping' in message.channel) {
      await message.channel.sendTyping();
    }

    const client = requireOpenRouterClient('image generation');
    const model = config.models.image;

    let messages: ImageConversationMessage[];
    if (shouldRefine && session) {
      // Multi-turn: include previous conversation + new edit instruction
      messages = [...session.conversationHistory, { role: 'user', content: prompt }];
    } else if (sourceImageUrl) {
      // New image with source reference — include the source image alongside the prompt
      messages = [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: sourceImageUrl } },
            { type: 'text', text: prompt },
          ],
        },
      ];
    } else {
      // New image
      messages = [{ role: 'user', content: prompt }];
    }

    const response = await client.chat.completions.create({
      model,
      messages: messages as OpenAI.ChatCompletionMessageParam[],
      // @ts-expect-error OpenRouter-specific field
      modalities: ['image'],
      provider: { zdr: true },
    });

    const imageResult = extractImageFromResponse(response);
    if (!imageResult) {
      // Fall back to text response if no image found
      const textResponse = response.choices[0]?.message?.content;
      if (textResponse) {
        return `Image generation didn't return an image. Model said: ${textResponse}`;
      }
      return 'Image generation returned no data.';
    }

    const imageBuffer = Buffer.from(imageResult.base64, 'base64');

    // Store session for iteration
    const assistantMessage: ImageConversationMessage = {
      role: 'assistant',
      content: [
        ...(imageResult.text ? [{ type: 'text', text: imageResult.text }] : []),
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageResult.base64}` } },
      ],
    };
    setSession(channelId, [...messages, assistantMessage]);

    const attachment = new AttachmentBuilder(imageBuffer, { name: 'image.png' });
    await message.reply({ content: 'Here is your image.', files: [attachment] });
    return shouldRefine ? 'Refined the previous image and sent it.' : 'Generated a new image and sent it.';
  } catch (error) {
    logger.error('Local image generation failed:', error);
    return 'Image generation failed.';
  }
}
