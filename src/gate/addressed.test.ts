import { afterEach, describe, expect, it, vi } from 'vitest';
import { DECISIONS_ENDPOINT } from '../ai/decisions';
import { ADDRESSED_QUESTION, type AddressedInput, buildAddressedState, createAddressedClassifier } from './addressed';

const INPUT: AddressedInput = {
  botName: 'Frigidaire',
  nicknames: ['fridge', 'frigidaire', 'frigi', 'bot', 'clanker'],
  message: { author: 'Marco', text: 'what about vs a ksante tho' },
  context: [
    { author: 'Marco', text: '@Frigidaire best jinx build?' },
    { author: 'Frigidaire', kind: 'self', text: "kraken into ie, don't overthink it", replyTo: 'Marco' },
    { author: 'Hermes', kind: 'other_bot', text: 'daily recap' },
  ],
  secondsSinceBotSpoke: 25,
  authorIsBotsPartner: true,
};

function fetchAnswering(noul: number) {
  const bodies: Array<Record<string, unknown>> = [];
  const impl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ model: 'typesafe/jev-1.13', answers: { answer: { type: 'noul', noul } }, usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200 },
    );
  });
  return { fetchImpl: impl as unknown as typeof globalThis.fetch, calls: impl, bodies };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildAddressedState', () => {
  it('labels the bot, other bots and replies, and describes the timing in words', () => {
    const state = buildAddressedState(INPUT);
    expect(state.recent_chat).toEqual([
      { author: 'Marco', text: '@Frigidaire best jinx build?' },
      { author: 'Frigidaire (the bot)', text: "kraken into ie, don't overthink it", replying_to: 'Marco' },
      { author: 'Hermes (a different bot, not Frigidaire)', text: 'daily recap' },
    ]);
    expect(state.latest_message).toEqual({ author: 'Marco', text: 'what about vs a ksante tho' });
    expect(state.bot_last_spoke).toBe('25 seconds before the latest message');
    expect(state.bot_was_just_talking_with_this_author).toBe('yes');
    // The bot's own name is not repeated as a nickname.
    expect(state.bot).toContain('People also call it: fridge, frigi, bot, clanker.');
    expect(JSON.stringify(state)).not.toMatch(/"\d+(\.\d+)?"/);
  });

  it('says "not recently" and "no" when the bot has not been talking with the author', () => {
    const state = buildAddressedState({ ...INPUT, secondsSinceBotSpoke: undefined, authorIsBotsPartner: false });
    expect(state.bot_last_spoke).toMatch(/^not recently/);
    expect(state.bot_was_just_talking_with_this_author).toBe('no');
  });

  it('truncates long texts so the state stays small', () => {
    const state = buildAddressedState({
      ...INPUT,
      message: { author: 'Kev', text: 'x'.repeat(5000), replyTo: 'Theo' },
      context: [{ author: 'Theo', text: 'y'.repeat(5000) }],
    });
    const latest = state.latest_message as { text: string; replying_to: string };
    expect(latest.text.length).toBeLessThanOrEqual(600);
    expect(latest.replying_to).toBe('Theo');
    expect((state.recent_chat as Array<{ text: string }>)[0].text.length).toBeLessThanOrEqual(300);
  });
});

describe('createAddressedClassifier', () => {
  it('asks the decision model the addressed question with ZDR routing', async () => {
    const { fetchImpl, calls, bodies } = decisionsFor(0.87);
    const classify = createAddressedClassifier({ apiKey: 'sk-test', fetch: fetchImpl });

    expect(await classify(INPUT)).toBe(0.87);

    expect(calls.mock.calls[0][0]).toBe(DECISIONS_ENDPOINT);
    const body = bodies[0];
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.provider).toEqual({ zdr: true });
    expect(body.state).toEqual(buildAddressedState(INPUT));
    expect(body.questions).toEqual({ answer: ADDRESSED_QUESTION });
  });

  it('uses GATE_MODEL, or an explicit model', async () => {
    vi.stubEnv('GATE_MODEL', '~typesafe/jev-latest');
    const first = decisionsFor(0.1);
    await createAddressedClassifier({ apiKey: 'k', fetch: first.fetchImpl })(INPUT);
    expect(first.bodies[0].model).toBe('~typesafe/jev-latest');

    const second = decisionsFor(0.1);
    await createAddressedClassifier({ apiKey: 'k', fetch: second.fetchImpl, model: 'typesafe/jev-9' })(INPUT);
    expect(second.bodies[0].model).toBe('typesafe/jev-9');
  });

  it('resolves undefined when the endpoint fails', async () => {
    const failing = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof globalThis.fetch;
    expect(await createAddressedClassifier({ apiKey: 'k', fetch: failing })(INPUT)).toBeUndefined();
  });
});

function decisionsFor(noul: number) {
  return fetchAnswering(noul);
}
