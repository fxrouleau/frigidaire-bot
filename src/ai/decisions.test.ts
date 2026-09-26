import { afterEach, describe, expect, it, vi } from 'vitest';

const recordUsage = vi.hoisted(() => vi.fn());
vi.mock('./usage', async (importOriginal) => ({ ...(await importOriginal<typeof import('./usage')>()), recordUsage }));

import { DECISIONS_ENDPOINT, type NoulQuestion, askNoul, askNouls, isDecisionModel } from './decisions';

type Step = { status?: number; body?: unknown; throws?: Error; hang?: boolean };

/** A fetch stub for the decisions endpoint that plays `steps` in order (the last one repeats). */
function decisionsFetch(steps: Step[]) {
  const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  let index = 0;
  const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    const step = steps[Math.min(index++, steps.length - 1)];
    if (step.hang) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    if (step.throws) throw step.throws;
    return new Response(step.body === undefined ? '' : JSON.stringify(step.body), {
      status: step.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetchImpl: impl as unknown as typeof globalThis.fetch, calls: impl, requests };
}

function answer(answers: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    body: {
      id: 'gen-dec-1',
      model: 'typesafe/jev-1.13-20260917',
      provider: 'TypeSafe',
      answers,
      usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
      ...extra,
    },
  };
}

const QUESTION: NoulQuestion = {
  type: 'noul',
  instructions: 'Is `message` a question?',
  criteria: { true: 'It asks something.', false: 'It states something.' },
};

afterEach(() => {
  recordUsage.mockReset();
  vi.unstubAllEnvs();
});

describe('isDecisionModel', () => {
  it('recognizes TypeSafe models and the -latest alias', () => {
    expect(isDecisionModel('typesafe/jev-1.13')).toBe(true);
    expect(isDecisionModel('~typesafe/jev-latest')).toBe(true);
    expect(isDecisionModel('deepseek/deepseek-v3.2:nitro')).toBe(false);
  });
});

describe('askNouls', () => {
  it('posts the state and questions with ZDR routing and returns each probability', async () => {
    const { fetchImpl, requests } = decisionsFetch([
      answer({ a: { type: 'noul', noul: 0.91 }, b: { type: 'noul', noul: 0.02 } }),
    ]);

    const result = await askNouls('typesafe/jev-1.13', { message: 'hi?' }, { a: QUESTION, b: QUESTION }, {
      feature: 'gate',
      apiKey: 'sk-test',
      fetch: fetchImpl,
    });

    expect(result).toEqual({ a: 0.91, b: 0.02 });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toBe(DECISIONS_ENDPOINT);
    expect(request.init.method).toBe('POST');
    expect((request.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(request.init.signal).toBeInstanceOf(AbortSignal);
    expect(request.body).toEqual({
      model: 'typesafe/jev-1.13',
      provider: { zdr: true },
      state: { message: 'hi?' },
      questions: { a: QUESTION, b: QUESTION },
    });
  });

  it('records usage under the caller feature with the served model snapshot', async () => {
    const { fetchImpl } = decisionsFetch([answer({ answer: { type: 'noul', noul: 0.5 } })]);
    const onUsage = vi.fn();

    await askNoul('typesafe/jev-1.13', 'state', QUESTION, { feature: 'ramble', apiKey: 'k', fetch: fetchImpl, onUsage });

    const expected = {
      feature: 'ramble',
      model: 'typesafe/jev-1.13-20260917',
      promptTokens: 476,
      completionTokens: 70,
      cost: 0.000019992,
    };
    expect(recordUsage).toHaveBeenCalledWith(expected);
    expect(onUsage).toHaveBeenCalledWith(expected);
  });

  it('retries a 5xx once and returns the second answer', async () => {
    const { fetchImpl, calls } = decisionsFetch([{ status: 503 }, answer({ answer: { type: 'noul', noul: 0.8 } })]);
    expect(await askNoul('m', 's', QUESTION, { feature: 'gate', apiKey: 'k', fetch: fetchImpl })).toBe(0.8);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 once', async () => {
    const { fetchImpl, calls } = decisionsFetch([{ status: 429 }, answer({ answer: { type: 'noul', noul: 0.3 } })]);
    expect(await askNoul('m', 's', QUESTION, { feature: 'gate', apiKey: 'k', fetch: fetchImpl })).toBe(0.3);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('gives up after two failed attempts', async () => {
    const { fetchImpl, calls } = decisionsFetch([{ throws: new TypeError('fetch failed') }]);
    expect(await askNoul('m', 's', QUESTION, { feature: 'gate', apiKey: 'k', fetch: fetchImpl })).toBeUndefined();
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx that retrying cannot fix', async () => {
    const { fetchImpl, calls } = decisionsFetch([{ status: 400, body: { error: { code: 400, message: 'bad' } } }]);
    expect(await askNoul('m', 's', QUESTION, { feature: 'gate', apiKey: 'k', fetch: fetchImpl })).toBeUndefined();
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('times out a hanging call and retries it once', async () => {
    const { fetchImpl, calls } = decisionsFetch([{ hang: true }]);
    const result = await askNoul('m', 's', QUESTION, { feature: 'gate', apiKey: 'k', fetch: fetchImpl, timeoutMs: 20 });
    expect(result).toBeUndefined();
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('returns undefined when any question lacks a numeric answer (and still records the billed usage)', async () => {
    const { fetchImpl } = decisionsFetch([answer({ a: { type: 'noul', noul: 0.9 }, b: { type: 'noul', noul: 'high' } })]);
    const result = await askNouls('m', 's', { a: QUESTION, b: QUESTION }, { feature: 'gate', apiKey: 'k', fetch: fetchImpl });
    expect(result).toBeUndefined();
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it('makes no call without an API key', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', undefined);
    const { fetchImpl, calls } = decisionsFetch([answer({ answer: { type: 'noul', noul: 0.9 } })]);
    expect(await askNoul('m', 's', QUESTION, { feature: 'gate', fetch: fetchImpl })).toBeUndefined();
    expect(calls).not.toHaveBeenCalled();
  });

  it('falls back to OPENROUTER_API_KEY from the environment', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-env');
    const { fetchImpl, requests } = decisionsFetch([answer({ answer: { type: 'noul', noul: 0.4 } })]);
    expect(await askNoul('m', 's', QUESTION, { feature: 'gate', fetch: fetchImpl })).toBe(0.4);
    expect((requests[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk-env');
  });
});
