import { AttachmentBuilder, type Message } from 'discord.js';
import type OpenAI from 'openai';
import { config } from '../../config';
import { logger } from '../../logger';
import type { SafeFetch } from '../linkReader/safeFetch';
import { downloadMedia, redact } from '../media/download';
import { requireOpenRouterClient } from '../openRouterClient';
import type { ImageGenerationOptions } from '../types';
import { featureRequestOptions } from '../usage';

export const GENERATED_IMAGE_NAME = 'image.png';

// What the tool result tells the chat model once the image exists: it is not posted yet — it rides on
// the model's own reply — so the model should caption it rather than describe it or promise it.
const ATTACHED_NOTE =
  'It will be attached to your reply automatically. Write a short in-character caption to go with it (a line, not a description of the image) — do not say you will send it, it is already on its way.';

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

/** A generated image as the response carried it: inline base64, or a URL to download. */
export type ExtractedImage = { base64?: string; url?: string; text?: string };

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;
// Image hosts and object stores sometimes label files generically.
const IMAGE_ACCEPT = ['image/*', 'application/octet-stream', 'binary/octet-stream'];

/** A data URL, an http(s) URL, or bare base64 → where the image bytes are. */
function imageRef(ref: string): Pick<ExtractedImage, 'base64' | 'url'> | undefined {
  const trimmed = ref.trim();
  const dataUrl = trimmed.match(/^data:image\/[^;]+;base64,([\s\S]+)$/);
  if (dataUrl) return { base64: dataUrl[1].replace(/\s/g, '') };
  if (/^https?:\/\//i.test(trimmed)) return { url: trimmed };
  if (trimmed.length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed)) return { base64: trimmed.replace(/\s/g, '') };
  return undefined;
}

/** One entry of `message.images`: OpenRouter sends `{ type: 'image_url', image_url: { url } }`; a bare string is tolerated. */
function imagesEntryRef(entry: unknown): Pick<ExtractedImage, 'base64' | 'url'> | undefined {
  if (typeof entry === 'string') return imageRef(entry);
  if (!entry || typeof entry !== 'object') return undefined;
  const imageUrl = (entry as { image_url?: unknown }).image_url;
  if (imageUrl && typeof imageUrl === 'object') {
    const url = (imageUrl as { url?: unknown }).url;
    if (typeof url === 'string') return imageRef(url);
  }
  const url = (entry as { url?: unknown }).url;
  return typeof url === 'string' ? imageRef(url) : undefined;
}

export function extractImageFromResponse(response: OpenAI.ChatCompletion): ExtractedImage | undefined {
  const message = response.choices[0]?.message;
  if (!message) return undefined;

  const content = message.content;
  const text = typeof content === 'string' && content.trim().length > 0 ? content : undefined;

  // OpenRouter's documented shape for image output on chat completions: message.images[].image_url.url
  // (a base64 data URL). Not in the OpenAI SDK's types, hence the widening.
  const extended = message as unknown as Record<string, unknown>;
  if (Array.isArray(extended.images)) {
    for (const entry of extended.images) {
      const ref = imagesEntryRef(entry);
      if (ref) return { ...ref, text };
    }
  }

  // Some providers inline a data URL in the text instead.
  if (typeof content === 'string') {
    const dataUrlMatch = content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
    if (dataUrlMatch) {
      return { base64: dataUrlMatch[1] };
    }
  }

  // Or return content blocks.
  if (Array.isArray(extended.content)) {
    for (const block of extended.content as Array<Record<string, unknown>>) {
      if (block.type === 'image_url') {
        const ref = imagesEntryRef(block);
        if (ref) return ref;
      }
      if (block.type === 'image' && typeof block.data === 'string') {
        return { base64: block.data };
      }
    }
  }

  return undefined;
}

/**
 * The image bytes. A URL-only result is a URL out of a model response, so it is downloaded like any URL
 * the bot didn't choose (src/ai/media/download.ts): only Discord's media hosts directly, everything else
 * through the SSRF-guarded fetch (public addresses only, every redirect re-checked, image types only),
 * capped at MAX_IMAGE_BYTES while streaming and at IMAGE_DOWNLOAD_TIMEOUT_MS overall.
 */
async function imageBytes(image: ExtractedImage, safeFetch: SafeFetch | undefined): Promise<Buffer | undefined> {
  if (image.base64) return Buffer.from(image.base64, 'base64');
  if (!image.url) return undefined;
  const download = await downloadMedia(image.url, {
    maxBytes: MAX_IMAGE_BYTES,
    timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
    accept: IMAGE_ACCEPT,
    safeFetch,
  });
  if (!download.ok) throw new Error(`generated image download failed (${download.reason}): ${redact(image.url)}`);
  return download.data;
}

/** Test seams: the OpenRouter client (defaults to the shared one) and the guarded fetch for URL-only results. */
export type ImageGeneratorDeps = { client?: OpenAI; safeFetch?: SafeFetch };

export async function generateLocalImage(
  message: Message,
  prompt: string,
  options?: ImageGenerationOptions,
  deps: ImageGeneratorDeps = {},
): Promise<string> {
  try {
    const shouldRefine = options?.refinePrevious ?? false;
    const sourceImageUrl = options?.sourceImageUrl;
    const channelId = message.channel.id;
    const session = getSession(channelId);

    if (shouldRefine && !session) {
      return 'I could not find a previous image to refine for this channel.';
    }

    // Best-effort: a missing typing permission must not cost the image.
    if (message.channel.isTextBased() && 'sendTyping' in message.channel) {
      await message.channel.sendTyping().catch((error: unknown) => logger.warn('image: sendTyping failed:', error));
    }

    const client = deps.client ?? requireOpenRouterClient('image generation');
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

    const response = await client.chat.completions.create(
      {
        model,
        messages: messages as OpenAI.ChatCompletionMessageParam[],
        // @ts-expect-error OpenRouter-specific field
        modalities: ['image'],
        provider: { zdr: true },
      },
      featureRequestOptions('image'),
    );

    const imageResult = extractImageFromResponse(response);
    if (!imageResult) {
      // Fall back to text response if no image found
      const textResponse = response.choices[0]?.message?.content;
      if (textResponse) {
        return `Image generation didn't return an image. Model said: ${textResponse}`;
      }
      return 'Image generation returned no data.';
    }

    const imageBuffer = await imageBytes(imageResult, deps.safeFetch);
    if (!imageBuffer || imageBuffer.byteLength === 0) return 'Image generation returned no data.';

    // Store session for iteration
    const assistantMessage: ImageConversationMessage = {
      role: 'assistant',
      content: [
        ...(imageResult.text ? [{ type: 'text', text: imageResult.text }] : []),
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBuffer.toString('base64')}` } },
      ],
    };
    setSession(channelId, [...messages, assistantMessage]);

    const done = shouldRefine ? 'Refined the previous image.' : 'Generated the image.';
    if (options?.turn) {
      // A second image in the same turn gets its own file name so the attachments stay distinct.
      const count = options.turn.files.filter((f) => f.name.startsWith('image')).length;
      const name = count === 0 ? GENERATED_IMAGE_NAME : `image-${count + 1}.png`;
      options.turn.files.push({ attachment: imageBuffer, name });
      return `${done} ${ATTACHED_NOTE}`;
    }

    // No turn to ride on (a caller outside the chat loop): post the image on its own.
    const attachment = new AttachmentBuilder(imageBuffer, { name: GENERATED_IMAGE_NAME });
    await message.reply({ files: [attachment] });
    return `${done} It was posted in the channel.`;
  } catch (error) {
    logger.error('Local image generation failed:', error);
    return 'Image generation failed.';
  }
}
