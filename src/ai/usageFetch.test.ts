import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaggedUsageEntry } from './usage';
import { FEATURE_HEADER } from './usage';
import { type Fetch, createUsageTrackingFetch, extractUsage, flushPendingUsage } from './usageFetch';

type Sent = { input: Parameters<Fetch>[0]; init: RequestInit | undefined };

function jsonResponse(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

const CHAT_BODY = {
  id: 'gen-1',
  object: 'chat.completion',
  model: 'deepseek/deepseek-v3.2',
  choices: [{ index: 0, message: { role: 'assistant', content: 'yo' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128, cost: 0.000045, is_byok: false },
};

function setup(respond: () => Response | Promise<Response>, opts: { enabled?: boolean } = {}) {
  const sent: Sent[] = [];
  const recorded: TaggedUsageEntry[] = [];
  const inner: Fetch = async (input, init) => {
    sent.push({ input, init });
    return respond();
  };
  const wrapped = createUsageTrackingFetch(inner, {
    record: (entry) => recorded.push(entry),
    isEnabled: () => opts.enabled ?? true,
  });
  return { wrapped, sent, recorded };
}

function taggedInit(feature: string, extra: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', 'X-Title': 'Frigidaire Bot', [FEATURE_HEADER]: feature, ...extra }),
    body: JSON.stringify({ model: 'deepseek/deepseek-v3.2:nitro', messages: [] }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createUsageTrackingFetch', () => {
  it('records the tagged feature with the response model, tokens and cost', async () => {
    const { wrapped, recorded } = setup(() => jsonResponse(CHAT_BODY));
    await wrapped('https://openrouter.ai/api/v1/chat/completions', taggedInit('learner'));
    await flushPendingUsage();

    expect(recorded).toEqual([
      { feature: 'learner', model: 'deepseek/deepseek-v3.2', promptTokens: 120, completionTokens: 8, cost: 0.000045 },
    ]);
  });

  it('strips the internal tag header before the request leaves the process, keeping every other header and the body', async () => {
    const { wrapped, sent } = setup(() => jsonResponse(CHAT_BODY));
    const init = taggedInit('chat');
    await wrapped('https://openrouter.ai/api/v1/chat/completions', init);

    const forwarded = new Headers(sent[0].init?.headers);
    expect(forwarded.has(FEATURE_HEADER)).toBe(false);
    expect(forwarded.get('X-Title')).toBe('Frigidaire Bot');
    expect(forwarded.get('content-type')).toBe('application/json');
    expect(sent[0].init?.body).toBe(init.body); // no usage flag injected: OpenRouter always returns usage
    expect(sent[0].init?.method).toBe('POST');
  });

  it('accepts headers as a plain object too', async () => {
    const { wrapped, sent, recorded } = setup(() => jsonResponse(CHAT_BODY));
    await wrapped('https://x', { method: 'POST', headers: { [FEATURE_HEADER]: 'summary', accept: 'application/json' } });
    await flushPendingUsage();

    expect(new Headers(sent[0].init?.headers).has(FEATURE_HEADER)).toBe(false);
    expect(recorded[0].feature).toBe('summary');
  });

  it("attributes untagged or malformed tags to 'other'", async () => {
    const { wrapped, recorded } = setup(() => jsonResponse(CHAT_BODY));
    await wrapped('https://x', { method: 'POST', headers: { accept: 'application/json' } });
    await wrapped('https://x', { method: 'POST' });
    await wrapped('https://x', taggedInit('Robert"); DROP TABLE'));
    await flushPendingUsage();

    expect(recorded.map((r) => r.feature)).toEqual(['other', 'other', 'other']);
  });

  it('hands the caller an unread response it can consume normally', async () => {
    const { wrapped } = setup(() => jsonResponse(CHAT_BODY));
    const response = await wrapped('https://x', taggedInit('chat'));
    expect(response.bodyUsed).toBe(false);
    expect(await response.json()).toEqual(CHAT_BODY);
    await flushPendingUsage();
  });

  it('does not inspect error responses, streams or non-JSON bodies', async () => {
    const bodies = [
      () => jsonResponse({ error: { message: 'rate limited', code: 429 } }, 429),
      () =>
        new Response('data: {"usage":{"cost":1}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      () => new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } }),
    ];
    for (const body of bodies) {
      const { wrapped, recorded } = setup(body);
      const response = await wrapped('https://x', taggedInit('chat'));
      await flushPendingUsage();
      expect(recorded).toEqual([]);
      expect(response.bodyUsed).toBe(false);
    }
  });

  it('records nothing for JSON without a usage object (model listings, 200-with-error bodies)', async () => {
    const { wrapped, recorded } = setup(() => jsonResponse({ error: { message: 'upstream died mid-generation' } }));
    await wrapped('https://x', taggedInit('chat'));
    await flushPendingUsage();
    expect(recorded).toEqual([]);
  });

  it('swallows a malformed JSON body or a failing ledger write without affecting the caller', async () => {
    const broken = setup(() => new Response('{"usage": ', { status: 200, headers: { 'content-type': 'application/json' } }));
    const response = await broken.wrapped('https://x', taggedInit('chat'));
    await flushPendingUsage();
    expect(broken.recorded).toEqual([]);
    expect(await response.text()).toBe('{"usage": ');

    const inner: Fetch = async () => jsonResponse(CHAT_BODY);
    const throwing = createUsageTrackingFetch(inner, {
      record: () => {
        throw new Error('disk full');
      },
      isEnabled: () => true,
    });
    const ok = await throwing('https://x', taggedInit('chat'));
    await flushPendingUsage();
    expect(ok.status).toBe(200);
  });

  it('propagates request failures untouched (the SDK retries on them)', async () => {
    const failure = new TypeError('fetch failed');
    const { wrapped, recorded } = setup(() => Promise.reject(failure));
    await expect(wrapped('https://x', taggedInit('chat'))).rejects.toBe(failure);
    expect(recorded).toEqual([]);
  });

  it('still strips the tag but records nothing when the ledger is disabled', async () => {
    const { wrapped, sent, recorded } = setup(() => jsonResponse(CHAT_BODY), { enabled: false });
    await wrapped('https://x', taggedInit('chat'));
    await flushPendingUsage();
    expect(recorded).toEqual([]);
    expect(new Headers(sent[0].init?.headers).has(FEATURE_HEADER)).toBe(false);
  });

  it('falls back to the requested model when the response names none', async () => {
    const { model: _omitted, ...withoutModel } = CHAT_BODY;
    const { wrapped, recorded } = setup(() => jsonResponse(withoutModel));
    await wrapped('https://x', taggedInit('chat'));
    await flushPendingUsage();
    expect(recorded[0].model).toBe('deepseek/deepseek-v3.2:nitro');
  });
});

describe('extractUsage', () => {
  it('reads an embeddings response (no completion tokens)', () => {
    const body = {
      object: 'list',
      data: [],
      model: 'qwen/qwen3-embedding-8b',
      usage: { prompt_tokens: 14, total_tokens: 14, cost: 0.00000014 },
    };
    expect(extractUsage(body, 'embedding')).toEqual({
      feature: 'embedding',
      model: 'qwen/qwen3-embedding-8b',
      promptTokens: 14,
      completionTokens: undefined,
      cost: 0.00000014,
    });
  });

  it('reads a speech-to-text response: input/output token names, model from the request', () => {
    const body = { text: 'salut', usage: { seconds: 9.2, input_tokens: 83, output_tokens: 30, cost: 0.000508 } };
    const request = JSON.stringify({ model: 'openai/gpt-4o-transcribe', input_audio: { data: 'AAAA', format: 'mp3' } });
    expect(extractUsage(body, 'transcription', request)).toEqual({
      feature: 'transcription',
      model: 'openai/gpt-4o-transcribe',
      promptTokens: 83,
      completionTokens: 30,
      cost: 0.000508,
    });
  });

  it('adds the upstream cost on BYOK calls, where `cost` is only the OpenRouter fee', () => {
    const body = {
      model: 'm',
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        cost: 0.001,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.02 },
      },
    };
    expect(extractUsage(body, 'chat')?.cost).toBeCloseTo(0.021, 10);
  });

  it('leaves cost undefined when the response has none', () => {
    expect(extractUsage({ model: 'm', usage: { prompt_tokens: 3 } }, 'chat')?.cost).toBeUndefined();
  });

  it('rejects bodies without a usage object', () => {
    expect(extractUsage(null, 'chat')).toBeUndefined();
    expect(extractUsage([], 'chat')).toBeUndefined();
    expect(extractUsage({ model: 'm', usage: 'lots' }, 'chat')).toBeUndefined();
  });

  it("falls back to 'unknown' when neither response nor request names a model", () => {
    expect(extractUsage({ usage: { cost: 0.1 } }, 'chat', 'not json')?.model).toBe('unknown');
  });
});
