import type OpenAI from 'openai';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeError } from '../debugCapture';
import { createReplayClient, loadFixture } from '../../test-support/openRouterFetch';
import type { ConversationEntry, ProviderToolDefinition } from '../types';
import { OpenRouterProvider, extractToolCalls, parseOpenRouterResponse } from './openRouterProvider';

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
    await provider.chat({ messages: [userWithImage('https://example.com/a.png')], tools: [] });

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
    await provider.chat({ messages: [userWithImage('https://example.com/missing.png')], tools: [] });

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
    await provider.chat({ messages: [userWithImage('https://example.com/huge.png')], tools: [] });

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
    await provider.chat({ messages: [userWithImage('https://example.com/big.png')], tools: [] });

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
