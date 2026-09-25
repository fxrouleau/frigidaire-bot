// One multimodal chat-completions call to OpenRouter for the media features. The OpenAI SDK's types
// only know `input_audio` with wav/mp3 and have no `video_url` part at all, so the request body is
// built with OpenRouter's own part shapes and bridged to the SDK type in exactly one place.
import OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { logger } from '../../logger';
import { type UsageFeature, featureRequestOptions } from '../usage';
import type { AudioFormat } from './formats';

export type MediaContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: AudioFormat } }
  | { type: 'video_url'; video_url: { url: string } };

export type MediaCompletionRequest = {
  client: OpenAI;
  model: string;
  feature: UsageFeature;
  system: string;
  content: MediaContentPart[];
  maxTokens: number;
  timeoutMs: number;
  /** `reasoning.effort` to send (see modelCatalog.ts); omitted ⇒ the model's own default. */
  reasoningEffort?: string;
};

type OpenRouterMediaBody = {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'system'; content: string } | { role: 'user'; content: MediaContentPart[] }>;
  reasoning?: { effort: string };
  provider: { zdr: true };
};

/**
 * Runs the call and returns the model's text ('' when it answered with nothing). Throws on API errors,
 * a response without choices, or a filtered/errored completion, so a broken call can never be mistaken
 * for an empty answer (and cached as one). Callers use isInputRejection() to tell "this input was
 * refused" apart from transient failures.
 *
 * No temperature is sent: Gemini 3 models are documented to loop and degrade below their default of
 * 1.0, so every model runs at its provider default. Reasoning effort is the caller's choice: the
 * media features ask for the lowest the model accepts, since writing down what was said or shown
 * needs little thought and reasoning is billed as output.
 */
export async function completeMedia(req: MediaCompletionRequest): Promise<string> {
  const body: OpenRouterMediaBody = {
    model: req.model,
    max_tokens: req.maxTokens,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.content },
    ],
    ...(req.reasoningEffort ? { reasoning: { effort: req.reasoningEffort } } : {}),
    // Zero data retention is non-negotiable here: this is members' voices and private clips.
    provider: { zdr: true },
  };

  const response = await req.client.chat.completions.create(body as unknown as ChatCompletionCreateParamsNonStreaming, {
    ...featureRequestOptions(req.feature),
    timeout: req.timeoutMs,
    maxRetries: 1,
  });

  const choice = response.choices?.[0];
  if (!choice) throw new Error(`${req.model} returned no choices`);
  const finish: string | null = choice.finish_reason;
  if (finish === 'content_filter' || finish === 'error') {
    throw new Error(`${req.model} finished with ${finish}`);
  }
  if (finish === 'length') {
    logger.warn(`media: ${req.model} hit max_tokens (${req.maxTokens}); keeping the truncated ${req.feature} output`);
  }
  const content: unknown = choice.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

/**
 * True when the provider refused the request itself (unsupported format, payload too large, bad
 * input) rather than failing transiently — the signal to retry with a different encoding.
 */
export function isInputRejection(error: unknown): boolean {
  return error instanceof OpenAI.APIError && [400, 413, 415, 422].includes(error.status ?? 0);
}

export function describeError(error: unknown): string {
  if (error instanceof OpenAI.APIError) return `HTTP ${error.status ?? '?'} ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
