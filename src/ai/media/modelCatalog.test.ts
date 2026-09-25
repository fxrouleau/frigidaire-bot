import { describe, expect, it } from 'vitest';
import { createCapturingClient } from '../../test-support/fakeMedia';
import { type OpenRouterFixture, loadFixture } from '../../test-support/openRouterFetch';
import { ModelCatalog, lowestEffort, parseCatalogEntry, staticModelInfo } from './modelCatalog';

const catalogFixture = loadFixture('models-catalog');
const serverError = loadFixture('http-500-error');

function setup(fixtures: OpenRouterFixture[]) {
  const { client, requests } = createCapturingClient(fixtures);
  let now = 1_000_000;
  const catalog = new ModelCatalog({ client: () => client, now: () => now });
  return {
    catalog,
    requests,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

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

describe('ModelCatalog', () => {
  it("reads modalities and the lowest effort from OpenRouter's model list", async () => {
    const { catalog, requests } = setup([catalogFixture]);

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

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://openrouter.ai/api/v1/models');
  });

  it('resolves routing suffixes to the base model', async () => {
    const { catalog } = setup([catalogFixture]);
    expect((await catalog.catalogInfo('z-ai/glm-5.3-flash:nitro'))?.inputModalities.has('video')).toBe(true);
  });

  it('answers unknown ids from the static fallback, and catalogInfo() with undefined', async () => {
    const { catalog } = setup([catalogFixture]);
    expect(await catalog.catalogInfo('google/gemini-9-flash')).toBeUndefined();
    expect((await catalog.info('google/gemini-9-flash')).inputModalities.has('audio')).toBe(true);
  });

  it('fetches once a day and shares one load between concurrent callers', async () => {
    const { catalog, requests, advance } = setup([catalogFixture, catalogFixture]);
    await Promise.all([catalog.info('z-ai/glm-5.3'), catalog.info('google/gemini-3.5-flash-lite')]);
    expect(requests).toHaveLength(1);

    advance(23 * 60 * 60 * 1000);
    await catalog.info('z-ai/glm-5.3');
    expect(requests).toHaveLength(1);

    advance(2 * 60 * 60 * 1000);
    await catalog.info('z-ai/glm-5.3');
    expect(requests).toHaveLength(2);
  });

  it('falls back to built-in defaults when the list is unreachable, and retries later', async () => {
    // A 5xx is retried once by the SDK before the load counts as failed.
    const { catalog, requests, advance } = setup([serverError, serverError, catalogFixture]);

    expect(await catalog.catalogInfo('z-ai/glm-5.3-flash')).toBeUndefined();
    expect((await catalog.info('google/gemini-3.5-flash-lite')).inputModalities.has('video')).toBe(true);
    expect(requests).toHaveLength(2);

    advance(11 * 60 * 1000);
    expect((await catalog.catalogInfo('z-ai/glm-5.3-flash'))?.lowestEffort).toBe('low');
    expect(requests).toHaveLength(3);
  });

  it('keeps the previous list when a refresh fails', async () => {
    const { catalog, advance } = setup([catalogFixture, serverError, serverError]);
    await catalog.info('z-ai/glm-5.3');
    advance(25 * 60 * 60 * 1000);
    expect((await catalog.catalogInfo('z-ai/glm-5.3-flash'))?.lowestEffort).toBe('low');
  });

  it('needs no request without an API key', async () => {
    const catalog = new ModelCatalog({ client: () => undefined });
    expect(await catalog.catalogInfo('z-ai/glm-5.3-flash')).toBeUndefined();
  });
});
