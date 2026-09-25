import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpenRouterClient } from '../../ai/openRouterClient';
import { FEATURE_HEADER, getUsageSummary } from '../../ai/usage';
import { type Fetch, flushPendingUsage } from '../../ai/usageFetch';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import {
  type JudgeInput,
  RUBRIC_DIMENSIONS,
  buildJudgeMessages,
  createLlmJudge,
  overallScore,
  parseJudgeVerdict,
} from './judge';

const DAY = 24 * 60 * 60 * 1000;

const INPUT: JudgeInput = {
  botName: 'Frigidaire',
  scenarioTitle: 'Roast request',
  intent: 'Lands a real roast.',
  transcript: '[now] Ana: @bot roast @Bo',
  storedMemories: ['Bo: Bo mains Yasuo.'],
  reply: 'Bo plays Yasuo like the wind owes him money.',
};

function verdictJson(score: number | string = 4): string {
  const scores = Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, { score, reason: `${d} ok` }]));
  return JSON.stringify({ scores, summary: 'solid' });
}

function completion(content: string) {
  return {
    id: 'gen-1',
    object: 'chat.completion',
    created: 1,
    model: 'google/gemini-3.1-pro-preview',
    choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020, cost: 0.003 },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setBotDbForTesting(undefined);
});

describe('parseJudgeVerdict', () => {
  it('parses a full verdict', () => {
    const verdict = parseJudgeVerdict(verdictJson(5));
    expect(verdict?.summary).toBe('solid');
    expect(verdict?.scores.brevity).toEqual({ score: 5, reason: 'brevity ok' });
    expect(Object.keys(verdict?.scores ?? {})).toEqual([...RUBRIC_DIMENSIONS]);
  });

  it('tolerates code fences and prose around the JSON, string scores and bare numbers', () => {
    const fenced = `Here you go:\n\`\`\`json\n${verdictJson('3')}\n\`\`\`\nHope that helps.`;
    expect(parseJudgeVerdict(fenced)?.scores.in_character.score).toBe(3);

    const bare = JSON.stringify({ scores: Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, 2])) });
    const verdict = parseJudgeVerdict(bare);
    expect(verdict?.scores.memory_use).toEqual({ score: 2, reason: '' });
    expect(verdict?.summary).toBe('');
  });

  it('clamps scores to 1..5 and rounds them', () => {
    expect(parseJudgeVerdict(verdictJson(9))?.scores.brevity.score).toBe(5);
    expect(parseJudgeVerdict(verdictJson(0))?.scores.brevity.score).toBe(1);
    expect(parseJudgeVerdict(verdictJson(3.6))?.scores.brevity.score).toBe(4);
  });

  it('rejects output without JSON, broken JSON, or a missing dimension', () => {
    expect(parseJudgeVerdict('I refuse to grade this.')).toBeUndefined();
    expect(parseJudgeVerdict('{"scores": {')).toBeUndefined();
    const partial = JSON.parse(verdictJson()) as { scores: Record<string, unknown> };
    delete partial.scores.memory_use;
    expect(parseJudgeVerdict(JSON.stringify(partial))).toBeUndefined();
    expect(parseJudgeVerdict(verdictJson('high'))).toBeUndefined();
  });
});

describe('overallScore', () => {
  it('is the mean of the dimension scores', () => {
    const verdict = parseJudgeVerdict(verdictJson(4));
    if (!verdict) throw new Error('expected a verdict');
    verdict.scores.brevity.score = 1;
    expect(overallScore(verdict)).toBeCloseTo((4 * (RUBRIC_DIMENSIONS.length - 1) + 1) / RUBRIC_DIMENSIONS.length);
  });
});

describe('buildJudgeMessages', () => {
  it('shows the judge the rubric, the scenario intent, the stored memories, the channel and the reply', () => {
    const [system, user] = buildJudgeMessages(INPUT);
    for (const d of RUBRIC_DIMENSIONS) expect(system.content).toContain(`- ${d}:`);
    expect(user.content).toContain('Lands a real roast.');
    expect(user.content).toContain('- Bo: Bo mains Yasuo.');
    expect(user.content).toContain('[now] Ana: @bot roast @Bo');
    expect(user.content).toContain('<<<\nBo plays Yasuo like the wind owes him money.\n>>>');
  });

  it('says so when nothing was stored', () => {
    expect(buildJudgeMessages({ ...INPUT, storedMemories: [] })[1].content).toContain('(nothing stored)');
  });
});

describe('createLlmJudge', () => {
  it("calls the judge model with ZDR routing, temperature 0 and the 'eval' feature tag", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const headers: Headers[] = [];
    const fetch: Fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      headers.push(new Headers(init?.headers));
      return jsonResponse(completion(verdictJson(4)));
    };
    const client = createOpenRouterClient({ apiKey: 'sk-test', fetch, maxRetries: 0 });
    const judge = createLlmJudge({ client, model: 'google/gemini-3.1-pro-preview' });

    const verdict = await judge(INPUT);
    await flushPendingUsage();

    expect(verdict.scores.answers_message.score).toBe(4);
    expect(bodies[0]).toMatchObject({ model: 'google/gemini-3.1-pro-preview', temperature: 0, provider: { zdr: true } });
    expect(headers[0].has(FEATURE_HEADER)).toBe(false);
    const spend = getUsageSummary(Date.now() - DAY, Date.now() + DAY);
    expect(spend.byFeature.map((f) => f.feature)).toEqual(['eval']);
  });

  it('retries unparseable output, then throws with a snippet of what came back', async () => {
    let calls = 0;
    const fetch: Fetch = async () => {
      calls++;
      return jsonResponse(completion(calls === 1 ? 'sorry, no' : verdictJson(2)));
    };
    const client = createOpenRouterClient({ apiKey: 'sk-test', fetch, maxRetries: 0 });

    expect((await createLlmJudge({ client, model: 'm' })(INPUT)).scores.brevity.score).toBe(2);
    expect(calls).toBe(2);

    calls = 0;
    const alwaysBad: Fetch = async () => {
      calls++;
      return jsonResponse(completion('no json here'));
    };
    const badClient = createOpenRouterClient({ apiKey: 'sk-test', fetch: alwaysBad, maxRetries: 0 });
    await expect(createLlmJudge({ client: badClient, model: 'm', attempts: 3 })(INPUT)).rejects.toThrow(
      'judge m returned no parseable verdict: no json here',
    );
    expect(calls).toBe(3);
  });
});
