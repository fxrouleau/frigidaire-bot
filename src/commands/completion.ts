// The one-shot chat-model call behind "Translate" and "Remember this": a system prompt, one user turn,
// no tools, no history. Routed with zero data retention like every OpenRouter request, and tagged
// 'command' so the spend shows up under the commands in the usage ledger. Reasoning is asked at the lowest
// effort: the default chat model (z-ai/glm-5.3-flash) reasons at 'max' unless told otherwise, reasoning
// counts toward max_tokens, and neither a translation nor a yes/no on one fact needs more.
import type OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { requireOpenRouterClient } from '../ai/openRouterClient';
import { featureRequestOptions } from '../ai/usage';
import { config } from '../config';
import type { CompletionRequest } from './types';

export type CompletionOptions = {
  /** Injected in tests (a replay client); defaults to the shared OpenRouter client. */
  client?: OpenAI;
  /** Defaults to the chat model. */
  model?: string;
};

type CompletionBody = {
  model: string;
  max_tokens: number;
  temperature: number;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  reasoning: { effort: 'low' };
  provider: { zdr: true };
};

export function createCompletion(
  opts: CompletionOptions = {},
): (request: CompletionRequest) => Promise<string | undefined> {
  return async (request) => {
    const client = opts.client ?? requireOpenRouterClient('context-menu commands');
    const body: CompletionBody = {
      model: opts.model ?? config.models.chat,
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? 0.2,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      reasoning: { effort: 'low' },
      provider: { zdr: true },
    };
    // The SDK's types know neither `provider` nor OpenRouter's `reasoning` object: bridged here, once.
    const response = await client.chat.completions.create(
      body as unknown as ChatCompletionCreateParamsNonStreaming,
      featureRequestOptions('command'),
    );
    const text = response.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : undefined;
  };
}
