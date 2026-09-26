// The one place an OpenRouter client is constructed. Every AI feature (chat, embeddings, image
// generation, emoji captions, learner, message judge) shares this instance; classes that accept a
// `client` option for tests bypass it.
//
// The shared client carries the house settings: a bounded per-attempt timeout and retry count (the SDK
// defaults are 10 minutes and 2 retries, and chat turns are serialized per channel, so one hung call
// used to stall the bot in that channel), and the usage-tracking fetch that attributes every call's
// cost to the feature that made it (src/ai/usageFetch.ts).
import OpenAI from 'openai';
import { config } from '../config';
import { createUsageTrackingFetch, type Fetch } from './usageFetch';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_HEADERS = { 'X-Title': 'Frigidaire Bot' } as const;

export type OpenRouterClientOptions = {
  apiKey: string;
  /** Default: OPENROUTER_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Default: OPENROUTER_MAX_RETRIES. */
  maxRetries?: number;
  /** The transport under the usage tracking (tests inject a fake; default: global fetch). */
  fetch?: Fetch;
};

/** Builds a client with the house settings. Prefer getOpenRouterClient(); this exists for tests and tooling. */
export function createOpenRouterClient(opts: OpenRouterClientOptions): OpenAI {
  return new OpenAI({
    apiKey: opts.apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: OPENROUTER_DEFAULT_HEADERS,
    timeout: opts.timeoutMs ?? config.openRouter.timeoutMs,
    maxRetries: opts.maxRetries ?? config.openRouter.maxRetries,
    fetch: createUsageTrackingFetch(opts.fetch),
  });
}

let sharedClient: OpenAI | undefined;
let sharedClientKey: string | undefined;

/** Returns the process-wide OpenRouter client, or undefined when OPENROUTER_API_KEY is unset. */
export function getOpenRouterClient(): OpenAI | undefined {
  const apiKey = config.openRouter.apiKey;
  if (!apiKey) return undefined;
  const timeoutMs = config.openRouter.timeoutMs;
  const maxRetries = config.openRouter.maxRetries;
  // Rebuilt when any setting it was built from changes (tests set env per case; prod never does).
  const key = JSON.stringify([apiKey, timeoutMs, maxRetries]);
  if (!sharedClient || sharedClientKey !== key) {
    sharedClient = createOpenRouterClient({ apiKey, timeoutMs, maxRetries });
    sharedClientKey = key;
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
