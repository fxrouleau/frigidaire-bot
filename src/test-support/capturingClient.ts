// An OpenAI-SDK client for OpenRouter that serves scripted responses and records every request's
// body AND headers (the replay clients in openRouterFetch.ts only see bodies) — for asserting ZDR
// routing and the per-feature usage header. The one capturing client in test-support: replies are
// scripted inline, or come from committed fixtures through fixtureReply().
import OpenAI from 'openai';
import type { OpenRouterFixture } from './openRouterFetch';

export type CapturedRequest = { url: string; body: Record<string, unknown>; headers: Headers };

/** One scripted reply: a JSON body (status 200 unless given), or a network-level failure. */
export type ScriptedReply = { status?: number; body: unknown } | { error: Error };

/** A committed OpenRouter fixture (loadFixture()) as a scripted reply: its status and response body. */
export function fixtureReply(fixture: OpenRouterFixture): ScriptedReply {
  return { status: fixture.status, body: fixture.response };
}

/** A minimal chat.completion body whose first choice says `content`. */
export function chatCompletionBody(content: string, model = 'test-model'): unknown {
  return {
    id: 'gen-test',
    object: 'chat.completion',
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  };
}

export function createCapturingClient(replies: ScriptedReply[]): { client: OpenAI; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const queue = [...replies];
  const fetchImpl = async (url: unknown, init?: { body?: unknown; headers?: unknown }): Promise<Response> => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    requests.push({ url: String(url), body, headers: new Headers(init?.headers as HeadersInit | undefined) });
    const reply = queue.shift();
    if (!reply) throw new Error(`capturingClient: no scripted reply left for request #${requests.length}`);
    if ('error' in reply) throw reply.error;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new OpenAI({
    apiKey: 'test-key',
    baseURL: 'https://openrouter.ai/api/v1',
    maxRetries: 0,
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
  });
  return { client, requests };
}
