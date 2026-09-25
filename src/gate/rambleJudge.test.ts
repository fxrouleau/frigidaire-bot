import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_HEADER } from '../ai/usage';
import { logger } from '../logger';
import { loadFixture } from '../test-support/openRouterFetch';
import {
  RAMBLE_SYSTEM_PROMPT,
  type RambleJudgeInput,
  buildRambleUserMessage,
  createChatRambleJudge,
  parseRambleVerdict,
} from './rambleJudge';

const INPUT: RambleJudgeInput = {
  author: 'Gus',
  run: [
    { text: 'ok so pigeons' },
    { text: 'they have never once been seen as babies. think about it', replyTo: 'Kev' },
    { text: 'and the moon landing was the same year the first pigeon census stopped' },
  ],
  before: [
    { author: 'Kev', text: 'anyone up for ranked' },
    { author: 'Frigidaire', text: 'always', self: true },
  ],
  examples: {
    rambles: ['what if clouds are just\nsky sheep\nand the sun is the shepherd', 'nobody talks about how spoons'],
    ramblesAreTheirs: true,
    normal: ['down for ranked at 9', 'lmao kev you are washed'],
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('buildRambleUserMessage', () => {
  it('shows the examples, what came right before (bot marked) and the run, in that order', () => {
    const text = buildRambleUserMessage(INPUT);
    const order = [
      'REAL RAMBLES by Gus, from the channel the group made for them:',
      '--- ramble 1 ---\nwhat if clouds are just\nsky sheep',
      '--- ramble 2 ---',
      "Gus's NORMAL messages in the main chat, for contrast:",
      '- down for ranked at 9',
      'RIGHT BEFORE THE RUN:',
      'Kev: anyone up for ranked',
      'Frigidaire (the bot): always',
      'THE RUN TO JUDGE: Gus, 3 messages in a row with nobody else in between:',
      'ok so pigeons',
      '(replying to Kev) they have never once been seen as babies',
      "Is this run one of Gus's rambles? JSON only.",
    ];
    let at = -1;
    for (const needle of order) {
      const next = text.indexOf(needle);
      expect(next, needle).toBeGreaterThan(at);
      at = next;
    }
  });

  it('says when it has no examples, and when the rambles are other members', () => {
    const zeroShot = buildRambleUserMessage({
      ...INPUT,
      before: [],
      examples: { rambles: [], ramblesAreTheirs: false, normal: [] },
    });
    expect(zeroShot).toContain('No archived rambles to compare with');
    expect(zeroShot).not.toContain('NORMAL messages');
    expect(zeroShot).toContain('RIGHT BEFORE THE RUN: (nothing in the last few minutes)');

    const others = buildRambleUserMessage({ ...INPUT, examples: { ...INPUT.examples, ramblesAreTheirs: false } });
    expect(others).toContain("REAL RAMBLES from the ramble channel (other members'");
  });

  it('keeps the newest messages of a run too long to send, and says how many were left out', () => {
    const run = Array.from({ length: 12 }, (_, i) => ({ text: `${i} ${'x'.repeat(1500)}` }));
    const text = buildRambleUserMessage({ ...INPUT, run });
    expect(text).toContain('(8 earlier message(s) not shown)');
    expect(text).toContain('\n11 xxx');
    expect(text).not.toContain('\n0 xxx');
    expect(text.length).toBeLessThan(7000);
  });

  it('describes a ramble by content, not volume, and asks for the JSON verdict', () => {
    expect(RAMBLE_SYSTEM_PROMPT).toContain('A ramble is content, not volume');
    expect(RAMBLE_SYSTEM_PROMPT).toContain('Several short messages in a row are normal chat');
    expect(RAMBLE_SYSTEM_PROMPT).toContain('{"ramble": true or false, "confidence"');
  });
});

describe('parseRambleVerdict', () => {
  it('reads the JSON verdict, fenced or not', () => {
    expect(parseRambleVerdict('{"ramble": true, "confidence": 0.9}')).toEqual({ ramble: true, confidence: 0.9 });
    expect(parseRambleVerdict('```json\n{ "ramble": false, "confidence": 0.8 }\n```')).toEqual({
      ramble: false,
      confidence: 0.8,
    });
  });

  it('scales a percentage and clamps, and treats a missing confidence as none', () => {
    expect(parseRambleVerdict('{"ramble": true, "confidence": 85}')).toEqual({ ramble: true, confidence: 0.85 });
    expect(parseRambleVerdict('{"ramble": true, "confidence": -2}')).toEqual({ ramble: true, confidence: 0 });
    expect(parseRambleVerdict('{"ramble": true}')).toEqual({ ramble: true, confidence: 0 });
  });

  it('gives up on anything else', () => {
    expect(parseRambleVerdict('')).toBeUndefined();
    expect(parseRambleVerdict('yes, a ramble')).toBeUndefined();
    expect(parseRambleVerdict('{"ramble": "yes", "confidence": 0.9}')).toBeUndefined();
    expect(parseRambleVerdict('{ramble: true}')).toBeUndefined();
  });
});

type Captured = { url: string; body: Record<string, unknown>; feature: string | null };

/** An SDK client whose transport serves `response` and captures what was sent. */
function clientServing(response: unknown, status = 200): { client: OpenAI; sent: Captured[] } {
  const sent: Captured[] = [];
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      feature: new Headers(init?.headers).get(FEATURE_HEADER),
    });
    return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } });
  };
  const client = new OpenAI({
    apiKey: 'sk-test',
    baseURL: 'https://openrouter.ai/api/v1',
    maxRetries: 0,
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
  });
  return { client, sent };
}

describe('createChatRambleJudge', () => {
  it('asks the chat model with ZDR routing, low reasoning effort and the ramble tag', async () => {
    vi.stubEnv('CHAT_MODEL', 'z-ai/glm-5.3-flash');
    const { client, sent } = clientServing(loadFixture('ramble-verdict').response);

    const verdict = await createChatRambleJudge({ client })(INPUT);

    expect(verdict).toEqual({ ramble: true, confidence: 0.86 });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent[0].feature).toBe('ramble');
    expect(sent[0].body).toMatchObject({
      model: 'z-ai/glm-5.3-flash',
      provider: { zdr: true },
      reasoning: { effort: 'low' },
      max_tokens: 1500,
      messages: [
        { role: 'system', content: RAMBLE_SYSTEM_PROMPT },
        { role: 'user', content: buildRambleUserMessage(INPUT) },
      ],
    });
  });

  it('fails closed on an unparseable answer, an API error, or no client', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const prose = clientServing({
      choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } }],
    });
    expect(await createChatRambleJudge({ client: prose.client, model: 'm/x' })(INPUT)).toBeUndefined();
    expect(String(warn.mock.calls[0][0])).toContain('gave no verdict (finish=length)');

    const failing = clientServing({ error: { message: 'No endpoints found matching your data policy' } }, 404);
    expect(await createChatRambleJudge({ client: failing.client, model: 'm/x' })(INPUT)).toBeUndefined();

    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(await createChatRambleJudge()(INPUT)).toBeUndefined();
  });
});
