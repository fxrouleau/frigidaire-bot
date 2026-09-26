import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logger';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import { createFileSafeFetch } from '../../test-support/fakeMedia';
import { type OpenRouterFixture, loadFixture } from '../../test-support/openRouterFetch';
import { createTurnEffects } from '../types';
import { FEATURE_HEADER } from '../usage';
import { GENERATED_IMAGE_NAME, MAX_IMAGE_BYTES, extractImageFromResponse, generateLocalImage } from './localImageGenerator';

function makeResponse(overrides: Partial<OpenAI.ChatCompletion['choices'][0]['message']>): OpenAI.ChatCompletion {
  return {
    id: 'test',
    object: 'chat.completion',
    created: Date.now(),
    model: 'test-model',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content: null,
          refusal: null,
          ...overrides,
        },
      },
    ],
  };
}

describe('extractImageFromResponse', () => {
  it('extracts base64 from data URL in content string', () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';
    const result = extractImageFromResponse(
      makeResponse({ content: `data:image/png;base64,${base64}` }),
    );
    expect(result).toBeDefined();
    expect(result!.base64).toBe(base64);
  });

  it('extracts from images array field', () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAE=';
    const response = makeResponse({ content: 'Here is your image' });
    // Attach custom images field
    (response.choices[0].message as unknown as Record<string, unknown>).images = [base64];
    const result = extractImageFromResponse(response);
    expect(result).toBeDefined();
    expect(result!.base64).toBe(base64);
    expect(result!.text).toBe('Here is your image');
  });

  it('extracts from content blocks with image_url type', () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAE=';
    const response = makeResponse({});
    (response.choices[0].message as unknown as Record<string, unknown>).content = [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
    ];
    const result = extractImageFromResponse(response);
    expect(result).toBeDefined();
    expect(result!.base64).toBe(base64);
  });

  it('extracts from content blocks with image type + data field', () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAE=';
    const response = makeResponse({});
    (response.choices[0].message as unknown as Record<string, unknown>).content = [
      { type: 'image', data: base64 },
    ];
    const result = extractImageFromResponse(response);
    expect(result).toBeDefined();
    expect(result!.base64).toBe(base64);
  });

  it('returns undefined for text-only content', () => {
    const result = extractImageFromResponse(
      makeResponse({ content: 'Just some text, no image here.' }),
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty/missing message', () => {
    const response: OpenAI.ChatCompletion = {
      id: 'test',
      object: 'chat.completion',
      created: Date.now(),
      model: 'test-model',
      choices: [],
    };
    expect(extractImageFromResponse(response)).toBeUndefined();
  });
});

describe('generateLocalImage', () => {
  type Captured = { body: Record<string, unknown>; feature: string | null };

  // A replay OpenAI client that also captures each request's body and feature header.
  function captureClient(fixture: OpenRouterFixture, captured: Captured[]): OpenAI {
    return new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://openrouter.ai/api/v1',
      maxRetries: 0,
      fetch: (async (_url: unknown, init?: { body?: unknown; headers?: HeadersInit }) => {
        captured.push({
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          feature: new Headers(init?.headers).get(FEATURE_HEADER),
        });
        return new Response(JSON.stringify(fixture.response), {
          status: fixture.status,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof globalThis.fetch,
    });
  }

  function fixtureWithImage(image: unknown): OpenRouterFixture {
    const fixture = loadFixture('image-generation');
    const response = structuredClone(fixture.response) as OpenAI.ChatCompletion;
    (response.choices[0].message as unknown as Record<string, unknown>).images = [image];
    return { ...fixture, response };
  }

  const FIXTURE_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGPgEpHjEpFjgFAABk4A8Z5vd+AAAAAASUVORK5CYII=';

  let channelCounter = 0;
  // Refine sessions are per channel and module-level: every test gets its own channel.
  const freshMessage = () => createFakeMessage({ channelId: `image-channel-${++channelCounter}` });

  beforeEach(() => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('puts the image on the turn instead of posting it, and asks the model for a caption', async () => {
    const captured: Captured[] = [];
    const fake = freshMessage();
    const turn = createTurnEffects();

    const result = await generateLocalImage(
      fake.message,
      'a fridge wearing sunglasses',
      { turn },
      { client: captureClient(loadFixture('image-generation'), captured) },
    );

    expect(turn.files).toHaveLength(1);
    expect(turn.files[0].name).toBe(GENERATED_IMAGE_NAME);
    expect(Buffer.isBuffer(turn.files[0].attachment)).toBe(true);
    expect((turn.files[0].attachment as Buffer).equals(Buffer.from(FIXTURE_PNG_BASE64, 'base64'))).toBe(true);
    expect(result).toContain('attached to your reply');
    expect(result).toContain('caption');
    // Nothing is posted on its own: the image rides on the model's reply.
    expect(fake.recorders.reply.calls).toHaveLength(0);

    expect(captured).toHaveLength(1);
    expect(captured[0].feature).toBe('image');
    expect(captured[0].body.provider).toEqual({ zdr: true });
    expect(captured[0].body.modalities).toEqual(['image']);
  });

  it('gives a second image in the same turn its own file name', async () => {
    const fake = freshMessage();
    const turn = createTurnEffects();
    const client = captureClient(loadFixture('image-generation'), []);

    await generateLocalImage(fake.message, 'one', { turn }, { client });
    await generateLocalImage(fake.message, 'two', { turn }, { client });

    expect(turn.files.map((f) => f.name)).toEqual(['image.png', 'image-2.png']);
  });

  it('posts the image on its own (without the old canned text) when there is no turn to ride on', async () => {
    const fake = freshMessage();

    const result = await generateLocalImage(fake.message, 'a fridge', {}, {
      client: captureClient(loadFixture('image-generation'), []),
    });

    expect(fake.recorders.reply.calls).toHaveLength(1);
    const [payload] = fake.recorders.reply.calls[0] as [{ content?: string; files: unknown[] }];
    expect(payload.content).toBeUndefined();
    expect(payload.files).toHaveLength(1);
    expect(result).toContain('posted in the channel');
  });

  it('keeps per-channel refine sessions: a refinement re-sends the previous image', async () => {
    const captured: Captured[] = [];
    const fake = freshMessage();
    const client = captureClient(loadFixture('image-generation'), captured);

    expect(
      await generateLocalImage(fake.message, 'make it blue', { refinePrevious: true, turn: createTurnEffects() }, { client }),
    ).toContain('could not find a previous image');

    await generateLocalImage(fake.message, 'a fridge', { turn: createTurnEffects() }, { client });
    const turn = createTurnEffects();
    const result = await generateLocalImage(fake.message, 'make it blue', { refinePrevious: true, turn }, { client });

    expect(result).toContain('Refined the previous image.');
    expect(turn.files).toHaveLength(1);
    const messages = captured[1].body.messages as Array<{ role: string; content: unknown }>;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(messages[1].content)).toContain(`data:image/png;base64,${FIXTURE_PNG_BASE64}`);
    expect(messages[2].content).toBe('make it blue');
  });

  const GEN_URL = 'https://cdn.example/gen.png';
  const urlOnly = () => captureClient(fixtureWithImage({ type: 'image_url', image_url: { url: GEN_URL } }), []);

  it('downloads a URL-only image result through the SSRF-guarded fetch', async () => {
    const fake = freshMessage();
    const turn = createTurnEffects();
    const bytes = Buffer.from(FIXTURE_PNG_BASE64, 'base64');
    const safeFetch = createFileSafeFetch({ [GEN_URL]: { body: bytes, contentType: 'image/png' } });

    await generateLocalImage(fake.message, 'a fridge', { turn }, { client: urlOnly(), safeFetch });

    expect(safeFetch.urls).toEqual([GEN_URL]);
    expect((turn.files[0].attachment as Buffer).equals(bytes)).toBe(true);
  });

  it('fails cleanly when the image download fails', async () => {
    const fake = freshMessage();
    const turn = createTurnEffects();
    const safeFetch = createFileSafeFetch({ [GEN_URL]: { body: Buffer.from('nope'), status: 403 } });

    const result = await generateLocalImage(fake.message, 'a fridge', { turn }, { client: urlOnly(), safeFetch });

    expect(result).toBe('Image generation failed.');
    expect(turn.files).toHaveLength(0);
  });

  it('never fetches a URL-only result that resolves to a private address', async () => {
    const fake = freshMessage();
    const turn = createTurnEffects();
    const bytes = Buffer.from(FIXTURE_PNG_BASE64, 'base64');
    const safeFetch = createFileSafeFetch(
      { [GEN_URL]: { body: bytes, contentType: 'image/png' } },
      { privateHosts: ['cdn.example'] },
    );

    const result = await generateLocalImage(fake.message, 'a fridge', { turn }, { client: urlOnly(), safeFetch });

    expect(result).toBe('Image generation failed.');
    expect(safeFetch.urls).toEqual([]);
    expect(turn.files).toHaveLength(0);
  });

  it('refuses an oversized or non-image download without reading its body', async () => {
    const png = Buffer.from(FIXTURE_PNG_BASE64, 'base64');
    for (const file of [
      { body: png, contentType: 'image/png', headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } },
      { body: Buffer.from('<html>login</html>'), contentType: 'text/html' },
    ]) {
      const turn = createTurnEffects();
      const safeFetch = createFileSafeFetch({ [GEN_URL]: file });
      const result = await generateLocalImage(freshMessage().message, 'a fridge', { turn }, { client: urlOnly(), safeFetch });
      expect(result).toBe('Image generation failed.');
      expect(safeFetch.bodies).toEqual([]);
      expect(turn.files).toHaveLength(0);
    }
  });

  it("relays the model's text when no image came back", async () => {
    const fake = freshMessage();
    const turn = createTurnEffects();
    const result = await generateLocalImage(fake.message, 'something weird', { turn }, {
      client: captureClient(loadFixture('text-response'), []),
    });

    expect(result).toContain("didn't return an image");
    expect(turn.files).toHaveLength(0);
  });
});
