import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';

const recordUsage = vi.hoisted(() => vi.fn());
vi.mock('./usage', async (importOriginal) => ({ ...(await importOriginal<typeof import('./usage')>()), recordUsage }));

import { createReplayClient } from '../test-support/openRouterFetch';
import { DECISIONS_ENDPOINT, type JudgeInput, createEdgyJudge, isDecisionModel } from './messageJudge';
import { FEATURE_HEADER } from './usage';

const TEXT_INPUT: JudgeInput = { author: 'Jasper', text: 'you are all clowns', imageUrls: [], attachmentNames: [] };
const IMAGE_ONLY_INPUT: JudgeInput = {
  author: 'Jasper',
  text: '',
  imageUrls: ['https://cdn.discordapp.com/attachments/1/2/spicy.png'],
  attachmentNames: ['spicy.png'],
};

/** A chat-completions replay client whose only response is the given assistant text. */
function chatClientSaying(content: string) {
  const requests: unknown[] = [];
  const client = createReplayClient(
    {
      version: 1,
      status: 200,
      response: {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'test-chat-model',
        choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop', logprobs: null }],
      },
    },
    (body) => requests.push(body),
  );
  return { client, requests };
}

/** A fetch stub for the decisions endpoint: answers with the given probability (or an HTTP status). */
function decisionsFetch(answer: { noul?: number; status?: number }) {
  const bodies: unknown[] = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (answer.status && answer.status !== 200) return new Response('', { status: answer.status });
    return new Response(JSON.stringify({ answers: { edgy: { type: 'noul', noul: answer.noul } }, usage: { cost: 0 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch, bodies, calls: fetchImpl };
}

afterEach(() => {
  vi.unstubAllEnvs();
  recordUsage.mockReset();
});

describe('isDecisionModel', () => {
  it('recognizes TypeSafe models', () => {
    expect(isDecisionModel('typesafe/jev-1.13')).toBe(true);
    expect(isDecisionModel('deepseek/deepseek-v3.2:nitro')).toBe(false);
  });
});

describe('createEdgyJudge with a decision model', () => {
  it('asks the decisions endpoint with ZDR routing and turns the probability into a verdict', async () => {
    const { fetchImpl, bodies, calls } = decisionsFetch({ noul: 0.91 });
    const judge = createEdgyJudge({ model: 'typesafe/jev-1.13', apiKey: 'sk-test', fetch: fetchImpl });

    expect(await judge(TEXT_INPUT)).toBe(true);

    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[0][0]).toBe(DECISIONS_ENDPOINT);
    const body = bodies[0] as { model: string; provider: unknown; state: { message: string; author: string }; questions: { edgy: { type: string } } };
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.provider).toEqual({ zdr: true });
    expect(body.state.message).toBe('you are all clowns');
    expect(body.state.author).toBe('Jasper');
    expect(body.questions.edgy.type).toBe('noul');
  });

  it('says not edgy below the threshold', async () => {
    const { fetchImpl } = decisionsFetch({ noul: 0.2 });
    const judge = createEdgyJudge({ model: 'typesafe/jev-1.13', apiKey: 'sk-test', fetch: fetchImpl });
    expect(await judge(TEXT_INPUT)).toBe(false);
  });

  it('honors a custom threshold', async () => {
    const { fetchImpl } = decisionsFetch({ noul: 0.5 });
    const judge = createEdgyJudge({ model: 'typesafe/jev-1.13', apiKey: 'sk-test', fetch: fetchImpl, threshold: 0.4 });
    expect(await judge(TEXT_INPUT)).toBe(true);
  });

  it('retries a 5xx once, then falls back to the chat model', async () => {
    const { fetchImpl, calls } = decisionsFetch({ status: 503 });
    const { client, requests } = chatClientSaying('{"edgy": false}');
    const judge = createEdgyJudge({ model: 'typesafe/jev-1.13', apiKey: 'sk-test', fetch: fetchImpl, client, fallbackModel: 'fallback-model' });

    expect(await judge(TEXT_INPUT)).toBe(false);

    expect(calls).toHaveBeenCalledTimes(2);
    expect((requests[0] as { model: string }).model).toBe('fallback-model');
  });

  it('skips the text-only decision model for an image-only message and uses the chat model', async () => {
    const { fetchImpl, calls } = decisionsFetch({ noul: 0.9 });
    const { client, requests } = chatClientSaying('{"edgy": true}');
    const judge = createEdgyJudge({ model: 'typesafe/jev-1.13', apiKey: 'sk-test', fetch: fetchImpl, client, fallbackModel: 'vision-model' });

    expect(await judge(IMAGE_ONLY_INPUT)).toBe(true);

    expect(calls).not.toHaveBeenCalled();
    const request = requests[0] as { model: string; messages: Array<{ role: string; content: unknown }> };
    expect(request.model).toBe('vision-model');
    const userContent = request.messages.find((m) => m.role === 'user')?.content as Array<{ type: string }>;
    expect(userContent.some((part) => part.type === 'image_url')).toBe(true);
  });

  it('attributes the decision call to the judge feature in the usage ledger', async () => {
    const { fetchImpl } = decisionsFetch({ noul: 0.91 });
    const judge = createEdgyJudge({ model: 'typesafe/jev-1.13', apiKey: 'sk-test', fetch: fetchImpl });

    await judge(TEXT_INPUT);

    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ feature: 'judge', model: 'typesafe/jev-1.13' }));
  });

  it('returns undefined when there is no API key and no chat client', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', undefined);
    const judge = createEdgyJudge({ model: 'typesafe/jev-1.13' });
    expect(await judge(TEXT_INPUT)).toBeUndefined();
  });
});

describe('createEdgyJudge with a chat model', () => {
  it('parses the JSON verdict and routes with ZDR', async () => {
    const { client, requests } = chatClientSaying('{"edgy": true}');
    const judge = createEdgyJudge({ model: 'some/chat-model', client });

    expect(await judge(TEXT_INPUT)).toBe(true);
    expect((requests[0] as { provider: unknown }).provider).toEqual({ zdr: true });
  });

  it('tolerates prose around the JSON', async () => {
    const { client } = chatClientSaying('Sure! {"edgy": false} — pretty tame.');
    const judge = createEdgyJudge({ model: 'some/chat-model', client });
    expect(await judge(TEXT_INPUT)).toBe(false);
  });

  it('tags the chat call with the judge feature header', async () => {
    const headers: Array<string | null> = [];
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://openrouter.ai/api/v1',
      maxRetries: 0,
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        headers.push(new Headers(init?.headers).get(FEATURE_HEADER));
        return new Response(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            created: 0,
            model: 'm',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '{"edgy": true}', refusal: null },
                finish_reason: 'stop',
                logprobs: null,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof globalThis.fetch,
    });
    const judge = createEdgyJudge({ model: 'some/chat-model', client });

    expect(await judge(TEXT_INPUT)).toBe(true);
    expect(headers).toEqual(['judge']);
  });

  it('leaves a reasoning model room to think before the verdict, at the lowest effort', async () => {
    // Like GLM-5.3-Flash at its default 'max' effort: reasoning counts toward max_tokens, and a tight cap
    // comes back cut off mid-thought with no content at all.
    const requests: Array<{ max_tokens: number; reasoning?: { effort: string } }> = [];
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://openrouter.ai/api/v1',
      maxRetries: 0,
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { max_tokens: number; reasoning?: { effort: string } };
        requests.push(body);
        const reasoningTokens = body.reasoning?.effort === 'low' ? 300 : 4000;
        const starved = body.max_tokens <= reasoningTokens;
        return new Response(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            created: 0,
            model: 'z-ai/glm-5.3-flash',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: starved ? '' : '{"edgy": true}', reasoning: 'Let me think…', refusal: null },
                finish_reason: starved ? 'length' : 'stop',
                logprobs: null,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof globalThis.fetch,
    });
    const judge = createEdgyJudge({ model: 'typesafe/jev-1.13', fallbackModel: 'z-ai/glm-5.3-flash', client });

    expect(await judge(IMAGE_ONLY_INPUT)).toBe(true);
    expect(requests[0].reasoning).toEqual({ effort: 'low' });
    expect(requests[0].max_tokens).toBeGreaterThanOrEqual(1000);
  });

  it('returns undefined when the model does not answer the question', async () => {
    const { client } = chatClientSaying('I would rather not say.');
    const judge = createEdgyJudge({ model: 'some/chat-model', client });
    expect(await judge(TEXT_INPUT)).toBeUndefined();
  });
});
