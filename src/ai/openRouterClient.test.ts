import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { captionEmoji } from './emojiCaptioner';
import { OpenRouterEmbeddingProvider } from './memory/embeddingProvider';
import { createOpenRouterClient, getOpenRouterClient } from './openRouterClient';
import { FEATURE_HEADER, featureRequestOptions, getUsageSummary } from './usage';
import { type Fetch, flushPendingUsage } from './usageFetch';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function chatCompletion(model: string, cost: number) {
  return {
    id: 'gen-1',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok', refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost, is_byok: false },
  };
}

function ledgerByFeature(): Record<string, { requests: number; costUsd: number }> {
  const summary = getUsageSummary(NOW - DAY, NOW + DAY);
  return Object.fromEntries(summary.byFeature.map((f) => [f.feature, { requests: f.requests, costUsd: f.costUsd }]));
}

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setBotDbForTesting(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('getOpenRouterClient settings', () => {
  it('is undefined without an API key', () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(getOpenRouterClient()).toBeUndefined();
  });

  it('bounds every call: 120 s per attempt and 2 retries by default (the SDK default is 10 minutes)', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    const client = getOpenRouterClient();
    expect(client?.timeout).toBe(120_000);
    expect(client?.maxRetries).toBe(2);
    expect(client?.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  it('reads OPENROUTER_TIMEOUT_MS / OPENROUTER_MAX_RETRIES and ignores out-of-range values', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    vi.stubEnv('OPENROUTER_TIMEOUT_MS', '30000');
    vi.stubEnv('OPENROUTER_MAX_RETRIES', '0');
    expect(getOpenRouterClient()?.timeout).toBe(30_000);
    expect(getOpenRouterClient()?.maxRetries).toBe(0);

    vi.stubEnv('OPENROUTER_TIMEOUT_MS', '5'); // below the 1 s floor
    vi.stubEnv('OPENROUTER_MAX_RETRIES', '99');
    expect(getOpenRouterClient()?.timeout).toBe(120_000);
    expect(getOpenRouterClient()?.maxRetries).toBe(2);
  });

  it('reuses one instance until a setting it was built from changes', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    const first = getOpenRouterClient();
    expect(getOpenRouterClient()).toBe(first);
    vi.stubEnv('OPENROUTER_TIMEOUT_MS', '60000');
    expect(getOpenRouterClient()).not.toBe(first);
  });
});

describe('usage tracking through the real SDK', () => {
  it('attributes a tagged chat completion to its feature and never sends the tag upstream', async () => {
    const seen: Headers[] = [];
    const fetch: Fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return jsonResponse(chatCompletion('qwen/qwen3-vl-235b-a22b-instruct', 0.0021));
    };
    const client = createOpenRouterClient({ apiKey: 'sk-test', fetch, maxRetries: 0 });

    const response = await client.chat.completions.create(
      { model: 'qwen/qwen3-vl-235b-a22b-instruct', messages: [{ role: 'user', content: 'hi' }] },
      featureRequestOptions('learner'),
    );
    await flushPendingUsage();

    expect(response.choices[0].message.content).toBe('ok');
    expect(seen[0].has(FEATURE_HEADER)).toBe(false);
    expect(seen[0].get('X-Title')).toBe('Frigidaire Bot');
    expect(ledgerByFeature()).toEqual({ learner: { requests: 1, costUsd: 0.0021 } });
    expect(getUsageSummary(NOW - DAY, NOW + DAY).byModel[0].model).toBe('qwen/qwen3-vl-235b-a22b-instruct');
  });

  it("tags embeddings as 'embedding'", async () => {
    const fetch: Fetch = async () =>
      jsonResponse({
        object: 'list',
        model: 'qwen/qwen3-embedding-8b',
        data: [{ object: 'embedding', index: 0, embedding: [3, 4] }],
        usage: { prompt_tokens: 5, total_tokens: 5, cost: 0.00000005 },
      });
    const client = createOpenRouterClient({ apiKey: 'sk-test', fetch, maxRetries: 0 });
    const provider = new OpenRouterEmbeddingProvider({ client, model: 'qwen/qwen3-embedding-8b' });

    await provider.embed(['Felix: likes pizza'], 'document');
    await flushPendingUsage();

    expect(ledgerByFeature()).toEqual({ embedding: { requests: 1, costUsd: 0.00000005 } });
  });

  it("tags emoji captions as 'emoji_caption' on the shared client", async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    vi.stubEnv('OPENROUTER_MAX_RETRIES', '0');
    const requests: string[] = [];
    // The shared client's transport is the global fetch, looked up per call — stubbed here, no network.
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      requests.push(String(input));
      return jsonResponse({
        ...chatCompletion('anthropic/claude-opus-4.7', 0.004),
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'sweating Pepe; for panic', refusal: null },
            finish_reason: 'stop',
          },
        ],
      });
    });

    const caption = await captionEmoji({ id: '123', name: 'monkaS', animated: false });
    await flushPendingUsage();

    expect(caption).toBe('sweating Pepe; for panic');
    expect(requests).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
    expect(ledgerByFeature()).toEqual({ emoji_caption: { requests: 1, costUsd: 0.004 } });
  });
});
