// The one-shot chat-model call behind "Translate" and "Remember this": a system prompt, one user turn,
// no tools, no history. Routed with zero data retention like every OpenRouter request, and tagged
// 'command' so the spend shows up under the commands in the usage ledger.
import type OpenAI from 'openai';
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

export function createCompletion(
  opts: CompletionOptions = {},
): (request: CompletionRequest) => Promise<string | undefined> {
  return async (request) => {
    const client = opts.client ?? requireOpenRouterClient('context-menu commands');
    const response = await client.chat.completions.create(
      {
        model: opts.model ?? config.models.chat,
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 0.2,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        // @ts-expect-error OpenRouter-specific field
        provider: { zdr: true },
      },
      featureRequestOptions('command'),
    );
    const text = response.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : undefined;
  };
}
