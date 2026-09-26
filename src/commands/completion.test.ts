import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { FEATURE_HEADER } from '../ai/usage';
import { loadFixture } from '../test-support/openRouterFetch';
import { createCompletion } from './completion';

type Captured = { url: string; body: Record<string, unknown>; headers: Headers };

/** An SDK client whose fetch serves `fixtureName` and records each request (body AND headers). */
function capturingClient(fixtureName: string, override?: unknown) {
  const fixture = loadFixture(fixtureName);
  const captured: Captured[] = [];
  const fetchImpl = async (url: unknown, init?: RequestInit) => {
    captured.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(override ?? fixture.response), {
      status: fixture.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new OpenAI({
    apiKey: 'test-key',
    baseURL: 'https://openrouter.ai/api/v1',
    maxRetries: 0,
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
  });
  return { client, captured };
}

describe('createCompletion', () => {
  it('sends one ZDR-routed, command-tagged, low-effort chat request and returns the trimmed answer', async () => {
    const { client, captured } = capturingClient('text-response');
    const complete = createCompletion({ client, model: 'test/model' });

    const answer = await complete({ system: 'be brief', user: 'bonjour', maxTokens: 123, temperature: 0.1 });

    expect(answer).toBe('Hello! This is a plain text reply.');
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(captured[0].body).toMatchObject({
      model: 'test/model',
      max_tokens: 123,
      temperature: 0.1,
      reasoning: { effort: 'low' },
      provider: { zdr: true },
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'bonjour' },
      ],
    });
    expect(captured[0].body.tools).toBeUndefined();
    expect(captured[0].headers.get(FEATURE_HEADER)).toBe('command');
  });

  it('defaults to the configured chat model', async () => {
    vi.stubEnv('CHAT_MODEL', 'some/chat-model');
    try {
      const { client, captured } = capturingClient('text-response');
      await createCompletion({ client })({ system: 's', user: 'u', maxTokens: 10 });
      expect(captured[0].body.model).toBe('some/chat-model');
      expect(captured[0].body.temperature).toBe(0.2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('returns undefined for an empty answer', async () => {
    const { client } = capturingClient('text-response', {
      id: 'x',
      object: 'chat.completion',
      created: 0,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: '   ', refusal: null }, finish_reason: 'stop' }],
    });
    expect(await createCompletion({ client })({ system: 's', user: 'u', maxTokens: 10 })).toBeUndefined();
  });

  it('throws on API errors (the dispatcher turns them into an in-character failure)', async () => {
    const { client } = capturingClient('http-500-error');
    await expect(createCompletion({ client })({ system: 's', user: 'u', maxTokens: 10 })).rejects.toThrow();
  });

  it('refuses to run without an OpenRouter key', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    try {
      await expect(createCompletion()({ system: 's', user: 'u', maxTokens: 10 })).rejects.toThrow(/OPENROUTER_API_KEY/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
