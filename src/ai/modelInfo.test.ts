import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import { MODELS_URL, ModelContextLengths, getModelContextLengths } from './modelInfo';

// The shape of GET https://openrouter.ai/api/v1/models (trimmed to the fields the lookup reads).
const LISTING = {
  data: [
    { id: 'deepseek/deepseek-v3.2', context_length: 163_840 },
    { id: 'moonshotai/kimi-k2', context_length: 131_072 },
    { id: 'openai/gpt-6-sol:batch', context_length: 400_000 },
    { id: 'broken/model', context_length: null },
  ],
};

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ModelContextLengths', () => {
  it('fetches the public model list once and serves every lookup from the cache', async () => {
    const fetch = vi.fn(async (_url: string) => okResponse(LISTING));
    const lengths = new ModelContextLengths({ fetch });

    expect(await lengths.get('deepseek/deepseek-v3.2')).toBe(163_840);
    expect(await lengths.get('moonshotai/kimi-k2')).toBe(131_072);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(MODELS_URL);
  });

  it('resolves a routing variant (":nitro") to its base model, but prefers an exact listed variant', async () => {
    const lengths = new ModelContextLengths({ fetch: async () => okResponse(LISTING) });
    expect(await lengths.get('deepseek/deepseek-v3.2:nitro')).toBe(163_840);
    expect(await lengths.get('openai/gpt-6-sol:batch')).toBe(400_000);
  });

  it('returns undefined for unknown models and entries without a usable context length', async () => {
    const lengths = new ModelContextLengths({ fetch: async () => okResponse(LISTING) });
    expect(await lengths.get('~anthropic/claude-sonnet-latest')).toBeUndefined();
    expect(await lengths.get('broken/model')).toBeUndefined();
  });

  it('never waits longer than asked; a slow list still lands for later calls', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lengths = new ModelContextLengths({
      fetch: async () => {
        await gate;
        return okResponse(LISTING);
      },
    });

    const started = Date.now();
    expect(await lengths.get('deepseek/deepseek-v3.2', 20)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);

    release?.();
    await vi.waitFor(() => expect(lengths.lookup('deepseek/deepseek-v3.2')).toBe(163_840));
  });

  it('logs a failure and backs off instead of refetching on every turn', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let now = 1_000_000;
    const fetch = vi.fn(async () => new Response('upstream down', { status: 503 }));
    const lengths = new ModelContextLengths({ fetch, now: () => now });

    expect(await lengths.get('deepseek/deepseek-v3.2')).toBeUndefined();
    expect(await lengths.get('deepseek/deepseek-v3.2')).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));

    now += 11 * 60 * 1000;
    fetch.mockImplementation(async () => okResponse(LISTING));
    expect(await lengths.get('deepseek/deepseek-v3.2')).toBe(163_840);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('treats an unexpected body shape as a failure', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const lengths = new ModelContextLengths({ fetch: async () => okResponse({ models: [] }) });
    expect(await lengths.get('deepseek/deepseek-v3.2')).toBeUndefined();
  });

  it('never fetches when disabled', async () => {
    const fetch = vi.fn(async () => okResponse(LISTING));
    const lengths = new ModelContextLengths({ fetch, enabled: false });
    expect(await lengths.get('deepseek/deepseek-v3.2')).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the shared instance is offline under Vitest (hermetic tests)', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(await getModelContextLengths().get('deepseek/deepseek-v3.2')).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
