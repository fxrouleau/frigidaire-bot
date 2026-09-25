import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import { loadFixture } from '../test-support/openRouterFetch';
import {
  MODELS_URL,
  ModelCatalog,
  ZDR_ENDPOINTS_URL,
  getModelCatalog,
  getModelContextLengths,
  lowestEffort,
  modelEndpointsUrl,
  parseCatalogEntry,
  staticModelInfo,
} from './modelCatalog';

// The shape of GET https://openrouter.ai/api/v1/models (trimmed to the fields the lookup reads).
const LISTING = {
  data: [
    { id: 'deepseek/deepseek-v3.2', context_length: 163_840 },
    { id: 'moonshotai/kimi-k2', context_length: 131_072 },
    { id: 'openai/gpt-6-sol:batch', context_length: 400_000 },
    { id: 'broken/model', context_length: null },
  ],
};
const CATALOG = loadFixture('models-catalog').response;
const ZDR = loadFixture('endpoints-zdr').response;
const WHISPER_ENDPOINTS = loadFixture('model-endpoints-whisper').response;
const GEMINI_ENDPOINTS = loadFixture('model-endpoints-gemini-flash-lite').response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Route = unknown | (() => Response);

/** A fetch answering by URL (404 for anything unrouted), recording every URL asked for. */
function routedFetch(routes: Record<string, Route>) {
  const urls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    urls.push(url);
    const route = routes[url];
    if (route === undefined) return json({ error: { message: 'Not Found', code: 404 } }, 404);
    return typeof route === 'function' ? (route as () => Response)() : json(route);
  });
  return { fetch, urls };
}

function setup(routes: Record<string, Route>) {
  const { fetch, urls } = routedFetch(routes);
  let now = 1_000_000;
  const catalog = new ModelCatalog({ fetch, now: () => now });
  return {
    catalog,
    fetch,
    urls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lowestEffort', () => {
  it('picks the last (lowest) listed effort', () => {
    expect(lowestEffort({ supported_efforts: ['high', 'medium', 'low', 'minimal'], mandatory: true })).toBe('minimal');
    expect(lowestEffort({ supported_efforts: ['max', 'high', 'low'], mandatory: true })).toBe('low');
  });

  it("switches reasoning off when it's optional, never when it's mandatory", () => {
    expect(lowestEffort({ supported_efforts: ['high', 'low', 'none'], mandatory: false })).toBe('none');
    expect(lowestEffort({ supported_efforts: ['high', 'low', 'none'], mandatory: true })).toBe('low');
  });

  it("uses 'low' when every effort is accepted, and nothing for non-reasoning models", () => {
    expect(lowestEffort({ supported_efforts: null })).toBe('low');
    expect(lowestEffort(null)).toBeUndefined();
    expect(lowestEffort(undefined)).toBeUndefined();
  });
});

describe('parseCatalogEntry', () => {
  it('ignores entries without input modalities', () => {
    expect(parseCatalogEntry({ id: 'x/y' })).toBeUndefined();
    expect(parseCatalogEntry({ id: 'x/y', architecture: { input_modalities: 'text' } })).toBeUndefined();
  });
});

describe('staticModelInfo', () => {
  it('assumes Gemini chat models hear and watch, and nothing about other models', () => {
    expect([...staticModelInfo('google/gemini-3.8-flash').inputModalities]).toEqual(
      expect.arrayContaining(['audio', 'video']),
    );
    expect(staticModelInfo('google/gemini-3.1-flash-image').inputModalities.has('video')).toBe(false);
    expect(staticModelInfo('z-ai/glm-5.3-flash').inputModalities.has('video')).toBe(false);
    expect(staticModelInfo('google/gemini-3.8-flash').lowestEffort).toBeUndefined();
  });
});

describe('modelEndpointsUrl', () => {
  it('builds the per-model endpoints path', () => {
    expect(modelEndpointsUrl('openai/whisper-large-v3')).toBe(
      'https://openrouter.ai/api/v1/models/openai/whisper-large-v3/endpoints',
    );
  });
});

describe('ModelCatalog: context lengths', () => {
  it('fetches the public model list once and serves every lookup from the cache', async () => {
    const { catalog, urls } = setup({ [MODELS_URL]: LISTING });

    expect(await catalog.contextLength('deepseek/deepseek-v3.2')).toBe(163_840);
    expect(await catalog.contextLength('moonshotai/kimi-k2')).toBe(131_072);
    expect(urls).toEqual([MODELS_URL]);
  });

  it('resolves a routing variant (":nitro") to its base model, but prefers an exact listed variant', async () => {
    const { catalog } = setup({ [MODELS_URL]: LISTING });
    expect(await catalog.contextLength('deepseek/deepseek-v3.2:nitro')).toBe(163_840);
    expect(await catalog.contextLength('openai/gpt-6-sol:batch')).toBe(400_000);
  });

  it('returns undefined for unknown models and entries without a usable context length', async () => {
    const { catalog } = setup({ [MODELS_URL]: LISTING });
    expect(await catalog.contextLength('~anthropic/claude-sonnet-latest')).toBeUndefined();
    expect(await catalog.contextLength('broken/model')).toBeUndefined();
  });

  it('never waits longer than asked; a slow list still lands for later calls', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const catalog = new ModelCatalog({
      fetch: async () => {
        await gate;
        return json(LISTING);
      },
    });

    const started = Date.now();
    expect(await catalog.contextLength('deepseek/deepseek-v3.2', 20)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);

    release?.();
    await vi.waitFor(() => expect(catalog.lookupContextLength('deepseek/deepseek-v3.2')).toBe(163_840));
  });

  it('logs a failure and backs off instead of refetching on every turn', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let status = 503;
    const { catalog, fetch, advance } = setup({
      [MODELS_URL]: () => (status === 200 ? json(LISTING) : new Response('upstream down', { status })),
    });

    expect(await catalog.contextLength('deepseek/deepseek-v3.2')).toBeUndefined();
    expect(await catalog.contextLength('deepseek/deepseek-v3.2')).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));

    advance(11 * 60 * 1000);
    status = 200;
    expect(await catalog.contextLength('deepseek/deepseek-v3.2')).toBe(163_840);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('treats an unexpected body shape as a failure', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { catalog } = setup({ [MODELS_URL]: { models: [] } });
    expect(await catalog.contextLength('deepseek/deepseek-v3.2')).toBeUndefined();
  });

  it('never fetches when disabled', async () => {
    const { fetch } = routedFetch({ [MODELS_URL]: LISTING });
    const catalog = new ModelCatalog({ fetch, enabled: false });
    expect(await catalog.contextLength('deepseek/deepseek-v3.2')).toBeUndefined();
    expect(await catalog.catalogInfo('google/gemini-3.5-flash-lite')).toBeUndefined();
    expect(await catalog.endpointCoverage('openai/whisper-large-v3')).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the shared instance is offline under Vitest (hermetic tests)', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(await getModelContextLengths().get('deepseek/deepseek-v3.2')).toBeUndefined();
    expect(await getModelCatalog().catalogInfo('google/gemini-3.5-flash-lite')).toBeUndefined();
    expect(await getModelCatalog().endpointCoverage('openai/whisper-large-v3')).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('ModelCatalog: modalities and reasoning effort', () => {
  it("reads modalities and the lowest effort from OpenRouter's model list", async () => {
    const { catalog, urls } = setup({ [MODELS_URL]: CATALOG });

    const flashLite = await catalog.info('google/gemini-3.5-flash-lite');
    expect(flashLite.inputModalities.has('audio')).toBe(true);
    expect(flashLite.inputModalities.has('video')).toBe(true);
    expect(flashLite.lowestEffort).toBe('minimal');

    const glm = await catalog.info('z-ai/glm-5.3-flash');
    expect(glm.inputModalities.has('video')).toBe(true);
    expect(glm.inputModalities.has('audio')).toBe(false);
    expect(glm.lowestEffort).toBe('low');

    expect((await catalog.info('google/gemini-3.1-pro-preview')).lowestEffort).toBe('low');
    expect((await catalog.info('openai/gpt-6-luna-pro')).lowestEffort).toBe('none');
    expect((await catalog.info('openai/gpt-audio-mini')).lowestEffort).toBeUndefined();

    // The same list also serves the context lengths: one fetch for both consumers.
    expect(catalog.lookupContextLength('z-ai/glm-5.3-flash')).toBe(1_310_720);
    expect(urls).toEqual([MODELS_URL]);
  });

  it('resolves routing suffixes to the base model', async () => {
    const { catalog } = setup({ [MODELS_URL]: CATALOG });
    expect((await catalog.catalogInfo('z-ai/glm-5.3-flash:nitro'))?.inputModalities.has('video')).toBe(true);
  });

  it('answers unknown ids from the static fallback, and catalogInfo() with undefined', async () => {
    const { catalog } = setup({ [MODELS_URL]: CATALOG });
    expect(await catalog.catalogInfo('google/gemini-9-flash')).toBeUndefined();
    expect((await catalog.info('google/gemini-9-flash')).inputModalities.has('audio')).toBe(true);
  });

  it('fetches once a day and shares one load between concurrent callers', async () => {
    const { catalog, urls, advance } = setup({ [MODELS_URL]: CATALOG });
    await Promise.all([catalog.info('z-ai/glm-5.3'), catalog.info('google/gemini-3.5-flash-lite')]);
    expect(urls).toHaveLength(1);

    advance(23 * 60 * 60 * 1000);
    await catalog.info('z-ai/glm-5.3');
    expect(urls).toHaveLength(1);

    advance(2 * 60 * 60 * 1000);
    await catalog.info('z-ai/glm-5.3');
    expect(urls).toHaveLength(2);
  });

  it('falls back to built-in defaults when the list is unreachable, and retries later', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let up = false;
    const { catalog, urls, advance } = setup({
      [MODELS_URL]: () => (up ? json(CATALOG) : new Response('bad gateway', { status: 502 })),
    });

    expect(await catalog.catalogInfo('z-ai/glm-5.3-flash')).toBeUndefined();
    expect((await catalog.info('google/gemini-3.5-flash-lite')).inputModalities.has('video')).toBe(true);
    expect(urls).toHaveLength(1);

    advance(11 * 60 * 1000);
    up = true;
    expect((await catalog.catalogInfo('z-ai/glm-5.3-flash'))?.lowestEffort).toBe('low');
    expect(urls).toHaveLength(2);
  });

  it('keeps the previous list when a refresh fails', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let up = true;
    const { catalog, advance } = setup({
      [MODELS_URL]: () => (up ? json(CATALOG) : new Response('bad gateway', { status: 502 })),
    });
    await catalog.info('z-ai/glm-5.3');
    up = false;
    advance(25 * 60 * 60 * 1000);
    expect((await catalog.catalogInfo('z-ai/glm-5.3-flash'))?.lowestEffort).toBe('low');
    expect(catalog.lookupContextLength('z-ai/glm-5.3-flash')).toBe(1_310_720);
  });
});

describe('ModelCatalog: endpoint coverage', () => {
  const WHISPER_URL = modelEndpointsUrl('openai/whisper-large-v3');
  const GEMINI_URL = modelEndpointsUrl('google/gemini-3.5-flash-lite');

  it('confirms every Whisper Large V3 host is on the ZDR list', async () => {
    const { catalog } = setup({ [ZDR_ENDPOINTS_URL]: ZDR, [WHISPER_URL]: WHISPER_ENDPOINTS });
    const coverage = await catalog.endpointCoverage('openai/whisper-large-v3');

    expect(coverage?.found).toBe(true);
    expect(coverage?.allZdr).toBe(true);
    expect(coverage?.outputModalities.has('transcription')).toBe(true);
    expect(coverage?.endpoints.map((e) => e.provider)).toEqual(['DeepInfra', 'Together', 'Groq']);
  });

  it('flags a model with any non-ZDR endpoint, naming the hosts', async () => {
    const { catalog } = setup({ [ZDR_ENDPOINTS_URL]: ZDR, [GEMINI_URL]: GEMINI_ENDPOINTS });
    const coverage = await catalog.endpointCoverage('google/gemini-3.5-flash-lite');

    expect(coverage?.allZdr).toBe(false);
    expect(coverage?.outputModalities.has('text')).toBe(true);
    expect(coverage?.endpoints.filter((e) => !e.zdr).map((e) => e.tag)).toEqual([
      'google-ai-studio/flex',
      'google-ai-studio',
      'google-ai-studio/priority',
    ]);
    expect(coverage?.endpoints.filter((e) => e.zdr)).toHaveLength(5);
  });

  it('treats a new host that is missing from the ZDR list as not ZDR', async () => {
    const withNewHost = structuredClone(WHISPER_ENDPOINTS) as { data: { endpoints: unknown[] } };
    withNewHost.data.endpoints.push({ model_id: 'openai/whisper-large-v3', provider_name: 'Nowhere', tag: 'nowhere' });
    const { catalog } = setup({ [ZDR_ENDPOINTS_URL]: ZDR, [WHISPER_URL]: withNewHost });

    const coverage = await catalog.endpointCoverage('openai/whisper-large-v3');
    expect(coverage?.allZdr).toBe(false);
    expect(coverage?.endpoints.find((e) => !e.zdr)?.provider).toBe('Nowhere');
  });

  it('answers found=false for an id OpenRouter does not know', async () => {
    const { catalog } = setup({ [ZDR_ENDPOINTS_URL]: ZDR });
    const coverage = await catalog.endpointCoverage('openai/whisper-nonexistent');
    expect(coverage).toMatchObject({ found: false, allZdr: false, endpoints: [] });
  });

  it('caches both lists for a day', async () => {
    const { catalog, urls, advance } = setup({ [ZDR_ENDPOINTS_URL]: ZDR, [WHISPER_URL]: WHISPER_ENDPOINTS });
    await catalog.endpointCoverage('openai/whisper-large-v3');
    await catalog.endpointCoverage('openai/whisper-large-v3');
    expect(urls).toHaveLength(2);

    advance(25 * 60 * 60 * 1000);
    await catalog.endpointCoverage('openai/whisper-large-v3');
    expect(urls).toHaveLength(4);
  });

  it('is undefined (not verified) when the lists are unreachable', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { catalog } = setup({ [ZDR_ENDPOINTS_URL]: () => new Response('down', { status: 503 }) });
    expect(await catalog.endpointCoverage('openai/whisper-large-v3')).toBeUndefined();
  });

  it('keeps a recent verdict through a failed refresh, but not a days-old one', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let up = true;
    const down = () => new Response('down', { status: 503 });
    const { catalog, advance } = setup({
      [ZDR_ENDPOINTS_URL]: () => (up ? json(ZDR) : down()),
      [WHISPER_URL]: () => (up ? json(WHISPER_ENDPOINTS) : down()),
    });
    expect((await catalog.endpointCoverage('openai/whisper-large-v3'))?.allZdr).toBe(true);

    up = false;
    advance(25 * 60 * 60 * 1000);
    expect((await catalog.endpointCoverage('openai/whisper-large-v3'))?.allZdr).toBe(true);

    advance(3 * 24 * 60 * 60 * 1000);
    expect(await catalog.endpointCoverage('openai/whisper-large-v3')).toBeUndefined();
  });
});
