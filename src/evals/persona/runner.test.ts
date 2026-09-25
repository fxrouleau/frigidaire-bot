import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMemoryStore } from '../../ai/memory';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import { FakeEmbeddingProvider } from '../../test-support/fakeEmbeddings';
import { FakeProvider, textResponse, toolCallResponse } from '../../test-support/fakeProvider';
import { type Judge, type JudgeInput, RUBRIC_DIMENSIONS } from './judge';
import { type RunnerDeps, renderTranscript, runPersonaEval, runScenario } from './runner';
import { type ScenarioFile, parseScenarioFile } from './scenarios';

const FILE: ScenarioFile = parseScenarioFile({
  version: 1,
  bot: { name: 'Frigidaire', id: '900000000000000001' },
  cast: [
    { name: 'Ana', id: '100000000000000001' },
    { name: 'Bo', id: '100000000000000002', username: 'bobo' },
  ],
  emojis: [{ id: '200000000000000001', name: 'KEKW', caption: 'laughing bald face; for extreme laughter' }],
  sharedMemories: [{ category: 'vibe', subject: 'server', content: 'The group roasts each other constantly.' }],
  scenarios: [
    {
      id: 'roast-bo',
      title: 'Roast Bo',
      memories: [{ category: 'fact', subject: 'Bo', content: 'Bo mains Yasuo and is hardstuck Gold.' }],
      history: [
        { author: 'Bo', content: 'my jungler was afk in spirit', minutesAgo: 6 },
        { author: 'bot', content: 'skill issue', minutesAgo: 5 },
      ],
      message: { author: 'Ana', content: '<@bot> roast <@Bo>' },
      expectations: { notes: 'A real roast.', maxSentences: 2, mustNotMatch: ['just kidding'] },
    },
    {
      id: 'new-job',
      title: 'Correction',
      memories: [{ category: 'fact', subject: 'Ana', content: 'Ana works at Ubisoft.' }],
      message: { author: 'Ana', content: "<@bot> I don't work at Ubisoft anymore, I'm at Shopify now" },
      expectations: {
        notes: 'Updates memory.',
        memoryAfter: { activeMustMatch: ['Shopify'], activeMustNotMatch: [] },
      },
    },
  ],
});

// The agent only runs tool calls the provider declares as host-handled.
const REMEMBER_FACT = {
  name: 'remember_fact',
  type: 'function' as const,
  description: 'Save to memory',
  parameters: { type: 'object', properties: {} },
  hostHandled: true,
};

const ROAST = FILE.scenarios[0];
const CORRECTION = FILE.scenarios[1];

function fullMarks(): ReturnType<Judge> {
  return Promise.resolve({
    scores: Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, { score: 5, reason: 'great' }])) as Awaited<
      ReturnType<Judge>
    >['scores'],
    summary: 'great',
  });
}

function deps(provider: FakeProvider, overrides: Partial<RunnerDeps> = {}): RunnerDeps & { judgeInputs: JudgeInput[] } {
  const judgeInputs: JudgeInput[] = [];
  return {
    makeProvider: () => provider,
    judge: (input) => {
      judgeInputs.push(input);
      return fullMarks();
    },
    judgeInputs,
    ...overrides,
  };
}

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  vi.stubEnv('DEBUG_CAPTURE', '0');
});

afterEach(() => {
  setBotDbForTesting(undefined);
  vi.unstubAllEnvs();
});

describe('runScenario', () => {
  it('runs the real orchestrator on seeded memories + history and captures, measures and judges the reply', async () => {
    const provider = new FakeProvider([textResponse('Bo plays Yasuo like the wind owes him money.')]);
    const d = deps(provider);

    const result = await runScenario(FILE, ROAST, 'candidate/model', d);

    expect(result).toMatchObject({
      model: 'candidate/model',
      scenarioId: 'roast-bo',
      reply: 'Bo plays Yasuo like the wind owes him money.',
      error: undefined,
      toolCalls: [],
      judgeError: undefined,
    });
    expect(result.metrics.sentences).toBe(1);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.judge?.summary).toBe('great');

    // The model saw the seeded memory, the channel history and the trigger with real mention tokens.
    const prompt = JSON.stringify(provider.calls[0]);
    expect(prompt).toContain('Bo mains Yasuo and is hardstuck Gold.');
    expect(prompt).toContain('my jungler was afk in spirit');
    expect(prompt).toContain('roast');

    // The judge got the transcript in reading order and everything the bot had stored.
    const [judged] = d.judgeInputs;
    expect(judged.transcript).toBe(renderTranscript(ROAST));
    expect(judged.storedMemories).toEqual([
      'server: The group roasts each other constantly.',
      'Bo: Bo mains Yasuo and is hardstuck Gold.',
    ]);
    expect(judged.reply).toBe(result.reply);
  });

  it('records the host tools the model called and checks the memory store after the turn', async () => {
    const provider = new FakeProvider([
      toolCallResponse([
        {
          id: 'call-1',
          name: 'remember_fact',
          arguments: { category: 'fact', subject: 'Ana', content: 'Ana works at Shopify now.' },
        },
      ]),
      textResponse('from games to checkout buttons, bold move'),
    ], { supportedTools: [REMEMBER_FACT] });

    const result = await runScenario(FILE, CORRECTION, 'm', deps(provider));

    expect(result.toolCalls).toEqual(['remember_fact']);
    expect(result.checks.find((c) => c.name === 'memory-has /Shopify/')).toMatchObject({ passed: true });
  });

  it('marks a failed turn as an error and does not ask the judge', async () => {
    const provider = new FakeProvider([{ error: new Error('upstream 503') }]);
    const d = deps(provider);

    const result = await runScenario(FILE, ROAST, 'm', d);

    expect(result.error).toBe('upstream 503');
    expect(result.judge).toBeUndefined();
    expect(d.judgeInputs).toHaveLength(0);
  });

  it('keeps the run when the judge fails, with the reason', async () => {
    const provider = new FakeProvider([textResponse('nah')]);
    const result = await runScenario(
      FILE,
      ROAST,
      'm',
      deps(provider, { judge: () => Promise.reject(new Error('judge offline')) }),
    );

    expect(result.reply).toBe('nah');
    expect(result.judge).toBeUndefined();
    expect(result.judgeError).toBe('judge offline');
  });

  it('prices the turn from the spend counter and uses the embeddings it is given', async () => {
    let spent = 0.01;
    const provider = new FakeProvider([
      (input) => {
        spent += 0.002;
        return textResponse(`seen ${input.messages.length} entries`);
      },
    ]);
    const embeddings = new FakeEmbeddingProvider();

    const result = await runScenario(
      FILE,
      ROAST,
      'm',
      deps(provider, { spendSoFar: async () => spent, makeEmbeddings: () => embeddings }),
    );

    expect(result.error).toBeUndefined();
    expect(result.reply).toMatch(/^seen \d+ entries$/);
    expect(result.costUsd).toBeCloseTo(0.002);
  });

  it('leaves no scenario state behind: the process-wide memory store is released after each run', async () => {
    const before = getMemoryStore();
    await runScenario(FILE, ROAST, 'm', deps(new FakeProvider([textResponse('ok')])));
    const after = getMemoryStore();
    expect(after).not.toBe(before);
    expect(after.getAllActive()).toEqual([]);
  });
});

describe('renderTranscript', () => {
  it('lists the history oldest first with relative ages, names for mentions, and the trigger last', () => {
    expect(renderTranscript(ROAST)).toBe(
      ['[6 min ago] Bo: my jungler was afk in spirit', '[5 min ago] bot: skill issue', '[now] Ana: @bot roast @Bo'].join(
        '\n',
      ),
    );
  });

  it('summarizes embeds so the judge knows what a meme was about', () => {
    const scenario = {
      ...ROAST,
      history: [{ author: 'Bo', content: '', minutesAgo: 2, embeds: [{ title: 'meme', description: 'a cat' }] }],
    };
    expect(renderTranscript(scenario).split('\n')[0]).toBe('[2 min ago] Bo:  [embed: meme — a cat]');
  });
});

describe('runPersonaEval', () => {
  it('runs every scenario against every model and summarizes per model', async () => {
    const providers = new Map([
      ['a', new FakeProvider([textResponse('one'), textResponse('two')])],
      ['b', new FakeProvider([textResponse('three'), textResponse('four')])],
    ]);
    const lines: string[] = [];

    const report = await runPersonaEval({
      file: FILE,
      scenarios: FILE.scenarios,
      models: ['a', 'b'],
      judgeModel: 'judge/model',
      deps: {
        makeProvider: (model) => providers.get(model) as FakeProvider,
        judge: () => fullMarks(),
        log: (line) => lines.push(line),
      },
    });

    expect(report.runs.map((r) => `${r.model}:${r.scenarioId}:${r.reply}`)).toEqual([
      'a:roast-bo:one',
      'a:new-job:two',
      'b:roast-bo:three',
      'b:new-job:four',
    ]);
    expect(report.summary.map((s) => [s.model, s.runs, s.overall])).toEqual([
      ['a', 2, 5],
      ['b', 2, 5],
    ]);
    expect(report).toMatchObject({ version: 1, judgeModel: 'judge/model', scenarioIds: ['roast-bo', 'new-job'] });
    expect(lines[0]).toBe('[a] 1/2 roast-bo');
    // The correction scenario expects a saved memory the scripted model never wrote.
    expect(lines.some((l) => l.includes('failed: memory-has /Shopify/'))).toBe(true);
  });
});
