import { type GenerateContentResult, GoogleGenerativeAI, type Part } from '@google/generative-ai';
import { AttachmentBuilder, type Message } from 'discord.js';
import { logger } from '../../logger';

type StoredImage = {
  data: Buffer;
  mimeType: string;
};

const lastImageByChannel = new Map<string, StoredImage>();

function getClient() {
  const apiKey = process.env.GOOGLE_GENAI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GOOGLE_GENAI_API_KEY (or GOOGLE_API_KEY) for local image generation.');
  }
  return new GoogleGenerativeAI(apiKey);
}

async function runGeminiImage(prompt: string, reference?: StoredImage): Promise<StoredImage> {
  const client = getClient();

  const model = client.getGenerativeModel({
    model: process.env.GOOGLE_IMAGE_MODEL ?? 'imagen-4.0-generate-001',
  });

  const parts: Part[] = [{ text: prompt }];
  if (reference) {
    parts.push({
      inlineData: {
        data: reference.data.toString('base64'),
        mimeType: reference.mimeType,
      },
    });
  }

  const result: GenerateContentResult = await model.generateContent({
    contents: [
      {
        role: 'user',
        parts,
      },
    ],
  });

  const images =
    result.response?.candidates?.[0]?.content?.parts?.filter(
      (p): p is Part & { inlineData: { data: string; mimeType?: string } } => Boolean(p.inlineData?.data),
    ) ?? [];
  if (images.length === 0) {
    throw new Error('Image generation returned no data.');
  }

  const first = images[0].inlineData;
  const mimeType = first.mimeType || 'image/png';
  const data = Buffer.from(first.data, 'base64');
  return { data, mimeType };
}

export async function generateLocalImage(
  message: Message,
  prompt: string,
  options?: { refinePrevious?: boolean },
): Promise<string> {
  try {
    const shouldRefine = options?.refinePrevious ?? false;
    const reference = shouldRefine ? lastImageByChannel.get(message.channel.id) : undefined;
    if (shouldRefine && !reference) {
      return 'I could not find a previous image to refine for this channel.';
    }

    if (message.channel.isTextBased() && 'sendTyping' in message.channel) {
      await message.channel.sendTyping();
    }

    const result = await runGeminiImage(prompt, reference);
    lastImageByChannel.set(message.channel.id, result);

    const attachment = new AttachmentBuilder(result.data, { name: 'image.png' });
    await message.reply({ content: 'Here is your image.', files: [attachment] });
    return shouldRefine ? 'Refined the previous image and sent it.' : 'Generated a new image and sent it.';
  } catch (error) {
    logger.error('Local image generation failed:', error);
    return 'Image generation failed (local generator).';
  }
}
