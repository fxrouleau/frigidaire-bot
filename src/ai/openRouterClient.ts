// The one place an OpenRouter client is constructed. Every AI feature (chat, embeddings, image
// generation, emoji captions, learner, message judge) shares this instance; classes that accept a
// `client` option for tests bypass it.
import OpenAI from 'openai';
import { config } from '../config';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_HEADERS = { 'X-Title': 'Frigidaire Bot' } as const;

let sharedClient: OpenAI | undefined;
let sharedClientKey: string | undefined;

/** Returns the process-wide OpenRouter client, or undefined when OPENROUTER_API_KEY is unset. */
export function getOpenRouterClient(): OpenAI | undefined {
  const apiKey = config.openRouter.apiKey;
  if (!apiKey) return undefined;
  if (!sharedClient || sharedClientKey !== apiKey) {
    sharedClient = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL, defaultHeaders: OPENROUTER_DEFAULT_HEADERS });
    sharedClientKey = apiKey;
  }
  return sharedClient;
}

/** Like getOpenRouterClient(), for paths that cannot degrade without a key. */
export function requireOpenRouterClient(feature: string): OpenAI {
  const client = getOpenRouterClient();
  if (!client) {
    throw new Error(`OPENROUTER_API_KEY is required for ${feature}.`);
  }
  return client;
}
