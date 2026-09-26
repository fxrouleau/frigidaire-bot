import OpenAI from 'openai';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeError } from '../debugCapture';
import { createReplayClient, loadFixture } from '../../test-support/openRouterFetch';
import { createFileSafeFetch } from '../../test-support/fakeMedia';
import type { ConversationEntry, ProviderToolDefinition } from '../types';
import { FEATURE_HEADER } from '../usage';
import {
  MAX_IMAGES_PER_REQUEST,
  OpenRouterProvider,
  extractToolCalls,
  imagesToHide,
  parseOpenRouterResponse,
} from './openRouterProvider';

// The replay client serves a recorded fixture body instead of hitting the network. parse helpers
// take the fixture's `response` field (an OpenAI ChatCompletion shape) directly.
function fixtureResponse(name: string): OpenAI.ChatCompletion {
  return loadFixture(name).response as OpenAI.ChatCompletion;
}

// Shape of the JSON body the provider sends to OpenRouter; loosely typed so tests can narrow.
type RequestBody = {
  model?: string;
  messages?: Array<{
    role: string;
    content?: unknown;
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
  }>;
  tools?: Array<{ type: string; function?: { name: string } }>;
  tool_choice?: unknown;
  provider?: unknown;
  models?: string[];
};

describe('parseOpenRouterResponse', () => {
  it('parses a plain text response', () => {
    const result = parseOpenRouterResponse(fixtureResponse('text-response'));
    expect(result.text).toBe('Hello! This is a plain text reply.');
    expect(result.toolCalls).toEqual([]);
    expect(result.outputEntries).toHaveLength(1);
    expect(result.outputEntries[0]).toEqual({
      kind: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello! This is a plain text reply.' }],
    });
  });

  it('parses a single tool call with parsed arguments', () => {
    const result = parseOpenRouterResponse(fixtureResponse('single-tool-call'));
    expect(result.toolCalls).toHaveLength(1);
    const call = result.toolCalls[0];
    expect(call.name).toBe('remember_fact');
    expect(call.arguments).toMatchObject({ subject: 'TestUser' });
    expect(result.outputEntries[0].kind).toBe('tool_call');
  });

  it('parses multiple tool calls in original order', () => {
    const result = parseOpenRouterResponse(fixtureResponse('multi-tool-calls'));
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.map((c) => c.name)).toEqual(['remember_fact', 'recall_memories']);
    expect(result.toolCalls.map((c) => c.id)).toEqual(['call_001', 'call_002']);
  });

  it('falls back to {} for malformed tool arguments without throwing', () => {
    const result = parseOpenRouterResponse(fixtureResponse('malformed-tool-args'));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].arguments).toEqual({});
  });

  it('synthesizes a non-empty id for a tool call with an empty id', () => {
    const result = parseOpenRouterResponse(fixtureResponse('empty-tool-call-id'));
    expect(result.toolCalls).toHaveLength(1);
    expect(typeof result.toolCalls[0].id).toBe('string');
    expect(result.toolCalls[0].id.length).toBeGreaterThan(0);
  });

  it('parses a message with both text and a tool call', () => {
    const result = parseOpenRouterResponse(fixtureResponse('text-with-tool-call'));
    expect(result.text).toBe('Let me remember that.');
    expect(result.toolCalls).toHaveLength(1);
    const kinds = result.outputEntries.map((e) => e.kind);
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('message');
    // tool_call must come before the assistant message entry
    expect(kinds.indexOf('tool_call')).toBeLessThan(kinds.indexOf('message'));
  });

  it('throws on a response with no choices and attaches rawResponse', () => {
    const response = fixtureResponse('no-choices-error');
    expect(() => parseOpenRouterResponse(response)).toThrow(/no choices/i);
    try {
      parseOpenRouterResponse(response);
      expect.fail('expected parseOpenRouterResponse to throw');
    } catch (error) {
      const captured = error as Error & { rawResponse?: unknown };
      expect(captured.rawResponse).toBe(response);
    }
  });

  it('filters out tool calls whose type is not function', () => {
    const response = {
      id: 'gen-inline-001',
      object: 'chat.completion',
      created: 1735689600,
      model: 'test-model',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          logprobs: null,
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'call_001',
                type: 'function',
                function: { name: 'remember_fact', arguments: '{"a":1}' },
              },
              {
                id: 'call_002',
                type: 'custom',
                custom: { name: 'something_else', input: 'x' },
              },
            ],
          },
        },
      ],
    } as unknown as OpenAI.ChatCompletion;

    const result = parseOpenRouterResponse(response);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('remember_fact');
  });
});

describe('extractToolCalls', () => {
  it('returns an empty array for an undefined message', () => {
    expect(extractToolCalls(undefined)).toEqual([]);
  });
});

describe('OpenRouterProvider request building', () => {
  function setup(fixtureName = 'text-response'): { provider: OpenRouterProvider; requests: unknown[] } {
    const requests: unknown[] = [];
    const provider = new OpenRouterProvider({
      client: createReplayClient(loadFixture(fixtureName), (body) => requests.push(body)),
      model: 'test-model',
    });
    return { provider, requests };
  }

  function userText(text: string): ConversationEntry {
    return { kind: 'message', role: 'user', content: [{ type: 'text', text }] };
  }

  it('maps a developer-role entry to a system message', async () => {
    const { provider, requests } = setup();
    await provider.chat({
      messages: [{ kind: 'message', role: 'developer', content: [{ type: 'text', text: 'You are a bot.' }] }],
      tools: [],
    });
    const body = requests[0] as RequestBody;
    expect(body.messages?.[0]).toEqual({ role: 'system', content: 'You are a bot.' });
  });

  it('merges consecutive tool_call entries plus a trailing assistant message into one assistant message', async () => {
    const { provider, requests } = setup();
    await provider.chat({
      messages: [
        { kind: 'tool_call', id: 't1', name: 'echo_tool', arguments: { a: 1 } },
        { kind: 'tool_call', id: 't2', name: 'recall_memories', arguments: { query: 'x' } },
        { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'thinking out loud' }] },
      ],
      tools: [],
    });
    const body = requests[0] as RequestBody;
    expect(body.messages).toHaveLength(1);
    const merged = body.messages?.[0];
    expect(merged?.role).toBe('assistant');
    expect(merged?.tool_calls).toHaveLength(2);
    expect(merged?.content).toBe('thinking out loud');
  });

  it('maps a tool_result entry to a tool message', async () => {
    const { provider, requests } = setup();
    await provider.chat({
      messages: [{ kind: 'tool_result', id: 'call_001', name: 'echo_tool', content: 'echoed' }],
      tools: [],
    });
    const body = requests[0] as RequestBody;
    expect(body.messages?.[0]).toEqual({ role: 'tool', tool_call_id: 'call_001', content: 'echoed' });
  });

  it('sends a single-text user message as a plain string', async () => {
    const { provider, requests } = setup();
    await provider.chat({ messages: [userText('hi there')], tools: [] });
    const body = requests[0] as RequestBody;
    expect(body.messages?.[0]).toEqual({ role: 'user', content: 'hi there' });
  });

  it('uses the default routing when none is configured', async () => {
    const { provider, requests } = setup();
    await provider.chat({ messages: [userText('hi')], tools: [] });
    const body = requests[0] as RequestBody;
    expect(body.provider).toEqual({ zdr: true, sort: 'throughput' });
  });

  it('uses custom routing supplied via the constructor', async () => {
    const requests: unknown[] = [];
    const provider = new OpenRouterProvider({
      client: createReplayClient(loadFixture('text-response'), (body) => requests.push(body)),
      model: 'test-model',
      routing: { only: ['amazon-bedrock'] },
    });
    await provider.chat({ messages: [userText('hi')], tools: [] });
    const body = requests[0] as RequestBody;
    expect(body.provider).toEqual({ only: ['amazon-bedrock'] });
  });

  it('serializes a function tool and a web_search tool', async () => {
    const { provider, requests } = setup();
    const tools: ProviderToolDefinition[] = [
      {
        name: 'remember_fact',
        type: 'function',
        description: 'remember a fact',
        parameters: { type: 'object', properties: {} },
        hostHandled: true,
      },
      { name: 'web_search', type: 'web_search', description: 'search the web', hostHandled: false },
    ];
    await provider.chat({ messages: [userText('hi')], tools });
    const body = requests[0] as RequestBody;
    expect(body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'remember_fact' }) }),
        { type: 'openrouter:web_search' },
      ]),
    );
  });

  it('passes tool_choice none when toolChoice is none', async () => {
    const { provider, requests } = setup();
    await provider.chat({ messages: [userText('hi')], tools: [], toolChoice: 'none' });
    const body = requests[0] as RequestBody;
    expect(body.tool_choice).toBe('none');
  });

  it('passes tool_choice auto by default', async () => {
    const { provider, requests } = setup();
    await provider.chat({ messages: [userText('hi')], tools: [] });
    const body = requests[0] as RequestBody;
    expect(body.tool_choice).toBe('auto');
  });

  it('uses the model override from the constructor', async () => {
    const { provider, requests } = setup();
    await provider.chat({ messages: [userText('hi')], tools: [] });
    const body = requests[0] as RequestBody;
    expect(body.model).toBe('test-model');
  });

  it('sends no fallback list when no fallback models are configured', async () => {
    const requests: unknown[] = [];
    const provider = new OpenRouterProvider({
      client: createReplayClient(loadFixture('text-response'), (body) => requests.push(body)),
      model: 'test-model',
      fallbackModels: [],
    });
    await provider.chat({ messages: [userText('hi')], tools: [] });
    expect((requests[0] as RequestBody).models).toBeUndefined();
    expect(provider.chatModels).toEqual(['test-model']);
  });

  it('routes through the fallback chain, primary first, keeping the ZDR provider preferences', async () => {
    const requests: unknown[] = [];
    const provider = new OpenRouterProvider({
      client: createReplayClient(loadFixture('text-response'), (body) => requests.push(body)),
      model: 'primary/model',
      fallbackModels: ['backup/one', 'primary/model', 'backup/two'],
    });
    await provider.chat({ messages: [userText('hi')], tools: [] });
    const body = requests[0] as RequestBody;
    expect(body.model).toBe('primary/model');
    expect(body.models).toEqual(['primary/model', 'backup/one', 'backup/two']);
    expect(body.provider).toEqual({ zdr: true, sort: 'throughput' });
    expect(provider.chatModels).toEqual(['primary/model', 'backup/one', 'backup/two']);
  });

  it('reads CHAT_FALLBACK_MODELS by default', async () => {
    vi.stubEnv('CHAT_FALLBACK_MODELS', 'backup/one');
    const requests: unknown[] = [];
    const provider = new OpenRouterProvider({
      client: createReplayClient(loadFixture('text-response'), (body) => requests.push(body)),
      model: 'test-model',
    });
    await provider.chat({ messages: [userText('hi')], tools: [] });
    expect((requests[0] as RequestBody).models).toEqual(['test-model', 'backup/one']);
    vi.unstubAllEnvs();
  });

  it('reports which model actually served the request', async () => {
    const { provider } = setup();
    const response = await provider.chat({ messages: [userText('hi')], tools: [] });
    // The fixture's response.model: under fallbacks this names the model that answered.
    expect(response.servedBy).toBe('deepseek/deepseek-v3.2:nitro');
  });

  it('tags the chat request with the chat feature header', async () => {
    const headers: Array<string | null> = [];
    const fixture = loadFixture('text-response');
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://openrouter.ai/api/v1',
      maxRetries: 0,
      fetch: (async (_url: unknown, init?: { headers?: HeadersInit }) => {
        headers.push(new Headers(init?.headers).get(FEATURE_HEADER));
        return new Response(JSON.stringify(fixture.response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof globalThis.fetch,
    });
    const provider = new OpenRouterProvider({ client, model: 'test-model', fallbackModels: [] });
    await provider.chat({ messages: [userText('hi')], tools: [] });
    expect(headers).toEqual(['chat']);
  });

  it('rejects on an HTTP 500 and serializeError captures the status', async () => {
    const provider = new OpenRouterProvider({
      client: createReplayClient(loadFixture('http-500-error')),
      model: 'test-model',
    });
    let caught: unknown;
    await expect(
      provider.chat({ messages: [userText('hi')], tools: [] }).catch((e) => {
        caught = e;
        throw e;
      }),
    ).rejects.toThrow();
    expect(serializeError(caught).status).toBe(500);
  });
});

describe('OpenRouterProvider image pipeline', () => {
  // The provider downloads images via the *global* fetch; the SDK client uses the replay fetch we
  // inject, so the two never collide. Stub global fetch per test.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function imageProvider(): { provider: OpenRouterProvider; requests: unknown[] } {
    const requests: unknown[] = [];
    const provider = new OpenRouterProvider({
      client: createReplayClient(loadFixture('text-response'), (body) => requests.push(body)),
      model: 'test-model',
    });
    return { provider, requests };
  }

  function userWithImage(url: string): ConversationEntry {
    return {
      kind: 'message',
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', url },
      ],
    };
  }

  // Returns a standalone ArrayBuffer (a valid BodyInit for Response) backing a real PNG.
  function toArrayBuffer(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }

  async function smallPng(): Promise<ArrayBuffer> {
    const buf = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } } })
      .png()
      .toBuffer();
    return toArrayBuffer(buf);
  }

  it('embeds a fetched image as a base64 data URL', async () => {
    const png = await smallPng();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
    );

    const { provider, requests } = imageProvider();
    await provider.chat({ messages: [userWithImage('https://cdn.discordapp.com/attachments/1/2/a.png')], tools: [] });

    const body = requests[0] as { messages?: Array<{ content?: unknown }> };
    const content = body.messages?.[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual(
      expect.arrayContaining([
        {
          type: 'image_url',
          image_url: { url: expect.stringMatching(/^data:image\/png;base64,/), detail: 'auto' },
        },
      ]),
    );
  });

  it('drops an image whose fetch returns 404', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('not found', { status: 404 }));

    const { provider, requests } = imageProvider();
    await provider.chat({ messages: [userWithImage('https://cdn.discordapp.com/attachments/1/2/missing.png')], tools: [] });

    const body = requests[0] as { messages?: Array<{ content?: unknown }> };
    const content = body.messages?.[0]?.content;
    // Only the text part remains, so it collapses to a plain string.
    expect(content).toBe('look at this');
  });

  it('drops an image whose content-length exceeds 10MB', async () => {
    const png = await smallPng();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(11 * 1024 * 1024) },
      }),
    );

    const { provider, requests } = imageProvider();
    await provider.chat({ messages: [userWithImage('https://cdn.discordapp.com/attachments/1/2/huge.png')], tools: [] });

    const body = requests[0] as { messages?: Array<{ content?: unknown }> };
    expect(body.messages?.[0]?.content).toBe('look at this');
  });

  it('passes a data: URL through unchanged without calling global fetch', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';
    const { provider, requests } = imageProvider();
    await provider.chat({ messages: [userWithImage(dataUrl)], tools: [] });

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    const body = requests[0] as { messages?: Array<{ content?: unknown }> };
    const content = body.messages?.[0]?.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(content).toEqual(
      expect.arrayContaining([{ type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } }]),
    );
  });

  it('resizes an oversized image down to the max dimension', async () => {
    const bigPng = await sharp({
      create: { width: 2000, height: 2000, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(toArrayBuffer(bigPng), { status: 200, headers: { 'content-type': 'image/png' } }),
    );

    const { provider, requests } = imageProvider();
    await provider.chat({ messages: [userWithImage('https://cdn.discordapp.com/attachments/1/2/big.png')], tools: [] });

    const body = requests[0] as { messages?: Array<{ content?: unknown }> };
    const content = body.messages?.[0]?.content as Array<{ type: string; image_url?: { url: string } }>;
    const imagePart = content.find((p) => p.type === 'image_url');
    expect(imagePart?.image_url?.url).toMatch(/^data:image\/png;base64,/);

    const base64 = imagePart!.image_url!.url.split(',')[1];
    const decoded = Buffer.from(base64, 'base64');
    const meta = await sharp(decoded).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1568);
  });
});

describe('OpenRouterProvider image pipeline: non-Discord hosts', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function chatWithImage(url: string, safeFetch: ReturnType<typeof createFileSafeFetch>) {
    const requests: unknown[] = [];
    const provider = new OpenRouterProvider({
      client: createReplayClient(loadFixture('text-response'), (body) => requests.push(body)),
      model: 'test-model',
      safeFetch,
    });
    await provider.chat({
      messages: [{ kind: 'message', role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', url }] }],
      tools: [],
    });
    return (requests[0] as { messages?: Array<{ content?: unknown }> }).messages?.[0]?.content;
  }

  it('downloads a link-preview image through the SSRF-guarded fetch, never the plain one', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png()
      .toBuffer();
    const safeFetch = createFileSafeFetch({ 'https://pbs.example/og.png': { body: png, contentType: 'image/png' } });

    const content = await chatWithImage('https://pbs.example/og.png', safeFetch);

    expect(content).toEqual(
      expect.arrayContaining([
        { type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,/), detail: 'auto' } },
      ]),
    );
    expect(safeFetch.urls).toEqual(['https://pbs.example/og.png']);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('drops an image on a host that resolves into the private network', async () => {
    const safeFetch = createFileSafeFetch(
      { 'https://internal.example/a.png': { body: Buffer.from('x'), contentType: 'image/png' } },
      { privateHosts: ['internal.example'] },
    );
    expect(await chatWithImage('https://internal.example/a.png', safeFetch)).toBe('look');
    expect(safeFetch.urls).toEqual([]);
  });

  it('drops a non-image response and SVGs', async () => {
    const safeFetch = createFileSafeFetch({
      'https://site.example/page': { body: Buffer.from('<html>'), contentType: 'text/html' },
      'https://site.example/logo.svg': { body: Buffer.from('<svg/>'), contentType: 'image/svg+xml' },
    });
    expect(await chatWithImage('https://site.example/page', safeFetch)).toBe('look');
    expect(await chatWithImage('https://site.example/logo.svg', safeFetch)).toBe('look');
  });
});

describe('OpenRouterProvider image cache', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads each image URL once per provider, not once per chat() call', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 255, b: 0 } } })
      .png()
      .toBuffer();
    vi.mocked(globalThis.fetch).mockImplementation(
      async () =>
        new Response(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    );

    const provider = new OpenRouterProvider({
      client: createReplayClient(loadFixture('text-response')),
      model: 'test-model',
    });
    const entry: ConversationEntry = {
      kind: 'message',
      role: 'user',
      content: [
        { type: 'text', text: 'same image twice' },
        { type: 'image', url: 'https://cdn.discordapp.com/attachments/1/2/cached.png' },
      ],
    };

    await provider.chat({ messages: [entry], tools: [] });
    await provider.chat({ messages: [entry, entry], tools: [] });

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  const pngBytes = () =>
    sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 255 } } })
      .png()
      .toBuffer();

  /** Serves the same small PNG for every URL and records which URLs were downloaded. */
  async function stubImageFetch(delayMs = 0): Promise<{ urls: string[]; maxInFlight: () => number }> {
    const png = await pngBytes();
    const urls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      urls.push(String(input instanceof Request ? input.url : input));
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight--;
      return new Response(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });
    return { urls, maxInFlight: () => maxInFlight };
  }

  const imageUrl = (n: number | string) => `https://cdn.discordapp.com/attachments/1/${n}/img.png`;
  const withImages = (...urls: string[]): ConversationEntry => ({
    kind: 'message',
    role: 'user',
    content: [{ type: 'text', text: 'pic' }, ...urls.map((url) => ({ type: 'image' as const, url }))],
  });

  function cachingProvider(requests: unknown[] = [], imageCacheMaxBytes?: number): OpenRouterProvider {
    return new OpenRouterProvider({
      client: createReplayClient(loadFixture('text-response'), (body) => requests.push(body)),
      model: 'test-model',
      fallbackModels: [],
      imageCacheMaxBytes,
    });
  }

  it('sends only the newest images of a long window, and every later round is served from the cache', async () => {
    const fetched = await stubImageFetch();
    const requests: unknown[] = [];
    const provider = cachingProvider(requests);
    const window = Array.from({ length: 150 }, (_, i) => withImages(imageUrl(i)));

    await provider.chat({ messages: window, tools: [] });
    await provider.chat({ messages: window, tools: [] });

    // The newest 40 are downloaded once; the second call (the next tool round) downloads nothing.
    expect(fetched.urls).toHaveLength(MAX_IMAGES_PER_REQUEST);
    expect(new Set(fetched.urls)).toEqual(new Set(Array.from({ length: 40 }, (_, i) => imageUrl(110 + i))));
    const body = requests[1] as RequestBody;
    type Part = { type: string; text?: string };
    const parts = (body.messages ?? []).flatMap((m): Part[] => (Array.isArray(m.content) ? (m.content as Part[]) : []));
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(40);
    expect(parts.filter((p) => p.type === 'text' && p.text === '[image]')).toHaveLength(110);
  });

  it('moves the image cut in steps, so the request prefix stays stable while new images arrive', () => {
    expect(imagesToHide(0)).toBe(0);
    expect(imagesToHide(40)).toBe(0);
    expect(imagesToHide(41)).toBe(10);
    expect(imagesToHide(50)).toBe(10);
    expect(imagesToHide(51)).toBe(20);
    expect(imagesToHide(150)).toBe(110);
  });

  it('keeps an image that is still in use cached while many newer ones pass through (LRU)', async () => {
    const fetched = await stubImageFetch();
    const provider = cachingProvider();
    const pinned = imageUrl('pinned');

    await provider.chat({ messages: [withImages(pinned)], tools: [] });
    for (let batch = 0; batch < 6; batch++) {
      const fresh = Array.from({ length: 30 }, (_, i) => imageUrl(`b${batch}-${i}`));
      await provider.chat({ messages: [withImages(pinned, ...fresh)], tools: [] });
    }

    expect(fetched.urls.filter((url) => url === pinned)).toHaveLength(1);
    expect(fetched.urls).toHaveLength(1 + 6 * 30);
  });

  it('restarts an image TTL on every use', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const fetched = await stubImageFetch();
      const provider = cachingProvider();
      const start = new Date('2026-09-25T12:00:00Z').getTime();
      for (const minutes of [0, 10, 20, 30]) {
        vi.setSystemTime(start + minutes * 60_000);
        await provider.chat({ messages: [withImages(imageUrl('kept'))], tools: [] });
      }
      expect(fetched.urls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the cache by size as well as count, evicting the least recently used image', async () => {
    const fetched = await stubImageFetch();
    const dataUriLength = `data:image/png;base64,${(await pngBytes()).toString('base64')}`.length;
    // Room for one image, not two.
    const provider = cachingProvider([], Math.floor(dataUriLength * 1.5));

    for (const url of [imageUrl('a'), imageUrl('b'), imageUrl('b'), imageUrl('a')]) {
      await provider.chat({ messages: [withImages(url)], tools: [] });
    }

    expect(fetched.urls).toEqual([imageUrl('a'), imageUrl('b'), imageUrl('a')]);
  });

  it("downloads a request's images a few at a time", async () => {
    const fetched = await stubImageFetch(20);
    const provider = cachingProvider();
    const urls = Array.from({ length: 12 }, (_, i) => imageUrl(`p${i}`));

    await provider.chat({ messages: [withImages(...urls)], tools: [] });

    expect(fetched.urls).toHaveLength(12);
    expect(fetched.maxInFlight()).toBeGreaterThan(1);
    expect(fetched.maxInFlight()).toBeLessThanOrEqual(4);
  });
});
