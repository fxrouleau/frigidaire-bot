import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEmbeddingProvider } from '../../test-support/fakeEmbeddings';
import { createReplayClient, loadFixture, type OpenRouterFixture } from '../../test-support/openRouterFetch';
import { OpenRouterEmbeddingProvider, makeDefaultEmbeddingProvider } from './embeddingProvider';
import { cosineSimilarity, dot } from './vectorMath';

// Shape of the JSON body the provider sends to the embeddings endpoint; loosely typed so tests can narrow.
type EmbeddingsRequestBody = {
  model?: string;
  input?: string[];
  encoding_format?: string;
  provider?: Record<string, unknown>;
};

function setup(fixtureName = 'embeddings-success', opts: { model?: string; routing?: Record<string, unknown> } = {}) {
  const requests: unknown[] = [];
  const provider = new OpenRouterEmbeddingProvider({
    client: createReplayClient(loadFixture(fixtureName), (body) => requests.push(body)),
    model: 'model' in opts ? opts.model : 'test-embedding-model',
    routing: opts.routing,
  });
  return { provider, requests };
}

describe('OpenRouterEmbeddingProvider request building', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends model, the input array, and float encoding format', async () => {
    const { provider, requests } = setup();
    await provider.embed(['Felix loves pizza', 'It was sunny today'], 'document');

    const body = requests[0] as EmbeddingsRequestBody;
    expect(body.model).toBe('test-embedding-model');
    expect(body.input).toEqual(['Felix loves pizza', 'It was sunny today']);
    expect(body.encoding_format).toBe('float');
  });

  it('sends ZDR provider routing by default (privacy requirement)', async () => {
    const { provider, requests } = setup();
    await provider.embed(['hello', 'world'], 'document');

    const body = requests[0] as EmbeddingsRequestBody;
    expect(body.provider).toEqual({ zdr: true });
  });

  it('uses custom routing supplied via the constructor', async () => {
    const { provider, requests } = setup('embeddings-success', { routing: { only: ['some-zdr-provider'] } });
    await provider.embed(['hello', 'world'], 'document');

    const body = requests[0] as EmbeddingsRequestBody;
    expect(body.provider).toEqual({ only: ['some-zdr-provider'] });
  });

  it('prefixes every query-kind text with the qwen3 instruct template', async () => {
    const { provider, requests } = setup();
    await provider.embed(['what does Felix like to eat', 'who plays minecraft'], 'query');

    const body = requests[0] as EmbeddingsRequestBody;
    expect(body.input).toHaveLength(2);
    expect(body.input?.[0]).toMatch(/^Instruct: .+\nQuery: what does Felix like to eat$/);
    expect(body.input?.[1]).toMatch(/^Instruct: .+\nQuery: who plays minecraft$/);
  });

  it('uses EMBEDDING_QUERY_INSTRUCTION as the instruct task when set', async () => {
    vi.stubEnv('EMBEDDING_QUERY_INSTRUCTION', 'Retrieve test memories');
    const { provider, requests } = setup();
    await provider.embed(['hello', 'world'], 'query');

    const body = requests[0] as EmbeddingsRequestBody;
    expect(body.input?.[0]).toBe('Instruct: Retrieve test memories\nQuery: hello');
    expect(body.input?.[1]).toBe('Instruct: Retrieve test memories\nQuery: world');
  });

  it('does not prefix document-kind texts', async () => {
    const { provider, requests } = setup();
    await provider.embed(['Felix: Felix loves pizza', 'weather: It was sunny today'], 'document');

    const body = requests[0] as EmbeddingsRequestBody;
    expect(body.input).toEqual(['Felix: Felix loves pizza', 'weather: It was sunny today']);
    expect(body.input?.join('\n')).not.toContain('Instruct:');
  });

  it('defaults the model to EMBEDDING_MODEL when no model option is given', async () => {
    vi.stubEnv('EMBEDDING_MODEL', 'env/embedding-model');
    const { provider, requests } = setup('embeddings-success', { model: undefined });
    await provider.embed(['hello', 'world'], 'document');

    expect(provider.model).toBe('env/embedding-model');
    const body = requests[0] as EmbeddingsRequestBody;
    expect(body.model).toBe('env/embedding-model');
  });

  it('falls back to the qwen3 default model when neither option nor env is set', () => {
    vi.stubEnv('EMBEDDING_MODEL', undefined);
    const { provider } = setup('embeddings-success', { model: undefined });
    expect(provider.model).toBe('qwen/qwen3-embedding-8b');
  });

  it('returns [] without calling the API for an empty input array', async () => {
    const { provider, requests } = setup();
    const result = await provider.embed([], 'document');

    expect(result).toEqual([]);
    expect(requests).toHaveLength(0);
  });
});

describe('OpenRouterEmbeddingProvider response parsing', () => {
  it('parses embeddings into L2-normalized Float32Arrays', async () => {
    // The fixture vectors have magnitudes 5 and 13 — the provider must normalize them to unit length.
    const { provider } = setup();
    const result = await provider.embed(['a', 'b'], 'document');

    expect(result).toHaveLength(2);
    for (const vector of result) {
      expect(vector).toBeInstanceOf(Float32Array);
      expect(vector.length).toBe(8);
      expect(Math.sqrt(dot(vector, vector))).toBeCloseTo(1, 5);
    }
  });

  it('returns vectors in input order with exact normalized values', async () => {
    const { provider } = setup();
    const [first, second] = await provider.embed(['a', 'b'], 'document');

    // fixture index 0: [3, 4, 0, ...] / 5
    expect(first[0]).toBeCloseTo(0.6, 5);
    expect(first[1]).toBeCloseTo(0.8, 5);
    // fixture index 1: [0, 0, 5, 12, ...] / 13
    expect(second[2]).toBeCloseTo(5 / 13, 5);
    expect(second[3]).toBeCloseTo(12 / 13, 5);
  });

  it('rejects on an HTTP 500 error response', async () => {
    const provider = new OpenRouterEmbeddingProvider({
      client: createReplayClient(loadFixture('embeddings-error')),
      model: 'test-embedding-model',
    });

    let caught: unknown;
    await expect(
      provider.embed(['hello'], 'document').catch((e) => {
        caught = e;
        throw e;
      }),
    ).rejects.toThrow();
    expect((caught as { status?: number }).status).toBe(500);
  });

  it('throws when the response contains no embedding data', async () => {
    const emptyDataFixture: OpenRouterFixture = {
      version: 1,
      status: 200,
      response: { object: 'list', data: [], model: 'test-embedding-model', usage: { prompt_tokens: 0, total_tokens: 0 } },
    };
    const provider = new OpenRouterEmbeddingProvider({
      client: createReplayClient(emptyDataFixture),
      model: 'test-embedding-model',
    });

    await expect(provider.embed(['hello'], 'document')).rejects.toThrow(/no data/i);
  });

  it('throws when the response has fewer vectors than inputs', async () => {
    // The success fixture has 2 vectors; ask for 3.
    const { provider } = setup();
    await expect(provider.embed(['a', 'b', 'c'], 'document')).rejects.toThrow(/3 inputs/);
  });

  it('throws when a returned embedding is empty', async () => {
    const emptyVectorFixture: OpenRouterFixture = {
      version: 1,
      status: 200,
      response: {
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [] }],
        model: 'test-embedding-model',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      },
    };
    const provider = new OpenRouterEmbeddingProvider({
      client: createReplayClient(emptyVectorFixture),
      model: 'test-embedding-model',
    });

    await expect(provider.embed(['hello'], 'document')).rejects.toThrow(/empty vector/i);
  });
});

describe('makeDefaultEmbeddingProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns undefined inside Vitest even when an API key is set (test hermeticity guard)', () => {
    expect(process.env.VITEST).toBeTruthy();
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    expect(makeDefaultEmbeddingProvider()).toBeUndefined();
  });

  it('returns undefined when OPENROUTER_API_KEY is missing', () => {
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('OPENROUTER_API_KEY', undefined);
    expect(makeDefaultEmbeddingProvider()).toBeUndefined();
  });

  it('returns undefined when the SEMANTIC_MEMORY_ENABLED kill switch is off', () => {
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');

    vi.stubEnv('SEMANTIC_MEMORY_ENABLED', 'false');
    expect(makeDefaultEmbeddingProvider()).toBeUndefined();

    vi.stubEnv('SEMANTIC_MEMORY_ENABLED', '0');
    expect(makeDefaultEmbeddingProvider()).toBeUndefined();
  });

  it('returns an OpenRouterEmbeddingProvider outside Vitest when a key is present', () => {
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    expect(makeDefaultEmbeddingProvider()).toBeInstanceOf(OpenRouterEmbeddingProvider);
  });

  it('returns an OpenRouterEmbeddingProvider when the kill switch is explicitly on', () => {
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    vi.stubEnv('SEMANTIC_MEMORY_ENABLED', 'true');
    expect(makeDefaultEmbeddingProvider()).toBeInstanceOf(OpenRouterEmbeddingProvider);
  });
});

describe('FakeEmbeddingProvider', () => {
  it('returns deterministic L2-normalized vectors', async () => {
    const fake = new FakeEmbeddingProvider();
    const [a1] = await fake.embed(['Felix loves pizza'], 'document');
    const [a2] = await fake.embed(['Felix loves pizza'], 'document');

    expect(Array.from(a1)).toEqual(Array.from(a2));
    expect(Math.sqrt(dot(a1, a1))).toBeCloseTo(1, 5);
  });

  it('gives texts sharing words a high cosine and disjoint texts a low cosine', async () => {
    const fake = new FakeEmbeddingProvider();
    const [pizza, food, weather] = await fake.embed(
      ['Felix loves pizza', 'Felix loves pasta', 'thunderstorms expected tomorrow'],
      'document',
    );

    const similar = cosineSimilarity(pizza, food);
    const dissimilar = cosineSimilarity(pizza, weather);
    expect(similar).toBeGreaterThan(0.6);
    expect(dissimilar).toBeLessThan(0.1);
    expect(similar).toBeGreaterThan(dissimilar);
  });

  it('is case-insensitive', async () => {
    const fake = new FakeEmbeddingProvider();
    const [lower, upper] = await fake.embed(['felix loves pizza', 'FELIX LOVES PIZZA'], 'document');
    expect(cosineSimilarity(lower, upper)).toBeCloseTo(1, 5);
  });

  it('records every call with its kind', async () => {
    const fake = new FakeEmbeddingProvider();
    await fake.embed(['a memory'], 'document');
    await fake.embed(['a question'], 'query');

    expect(fake.calls).toEqual([
      { texts: ['a memory'], kind: 'document' },
      { texts: ['a question'], kind: 'query' },
    ]);
  });

  it('rejects while failWith is set and recovers when cleared', async () => {
    const fake = new FakeEmbeddingProvider();
    fake.failWith = new Error('simulated outage');

    await expect(fake.embed(['x'], 'document')).rejects.toThrow('simulated outage');
    // The failed call is still recorded.
    expect(fake.calls).toHaveLength(1);

    fake.failWith = undefined;
    const [vector] = await fake.embed(['x'], 'document');
    expect(vector).toBeInstanceOf(Float32Array);
  });

  it('exposes vectorFor() matching what embed() returns', async () => {
    const fake = new FakeEmbeddingProvider();
    const [embedded] = await fake.embed(['Felix loves pizza'], 'document');
    expect(Array.from(FakeEmbeddingProvider.vectorFor('Felix loves pizza'))).toEqual(Array.from(embedded));
  });
});
