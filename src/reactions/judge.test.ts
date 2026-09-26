import { describe, expect, it } from 'vitest';
import { FEATURE_HEADER } from '../ai/usage';
import { chatCompletionBody, createCapturingClient } from '../test-support/capturingClient';
import type { ReactionGuide } from './guide';
import { type JudgeInput, buildSystemPrompt, buildUserText, createAutoReactJudge, parseVerdict } from './judge';

const GUIDE: ReactionGuide = {
  messages: 1000,
  reactedMessages: 250,
  baseRate: 0.25,
  emojis: [],
  text: 'About 25% of member posts here get any reaction at all (250 of 1000).\n- :KEKW: (40×) — "a hydrant"',
  builtAt: 0,
};

const INPUT: JudgeInput = {
  guide: GUIDE,
  context: [
    { author: 'Dale', text: 'who is driving tonight' },
    { author: 'Frigidaire (the bot)', text: 'not me' },
  ],
  post: {
    author: 'Remi',
    text: 'I just parallel parked into a hydrant',
    notes: ['[reactions so far: 😂×2]'],
    images: ['data:image/jpeg;base64,AAAA'],
  },
};

describe('parseVerdict', () => {
  it('reads a plain JSON answer', () => {
    expect(parseVerdict('{"react": true, "emoji": "KEKW", "why": "legendary fail"}')).toEqual({
      react: true,
      emoji: 'KEKW',
      why: 'legendary fail',
    });
  });

  it('tolerates fences, prose and string booleans', () => {
    expect(parseVerdict('Sure:\n```json\n{"react": "false", "emoji": "", "why": "just logistics"}\n```')).toEqual({
      react: false,
      emoji: undefined,
      why: 'just logistics',
    });
  });

  it('rejects anything without a boolean react', () => {
    expect(parseVerdict('no')).toBeUndefined();
    expect(parseVerdict('{"react": "maybe"}')).toBeUndefined();
    expect(parseVerdict('{"emoji": "😂"}')).toBeUndefined();
    expect(parseVerdict('[true]')).toBeUndefined();
    expect(parseVerdict('{"react": tru')).toBeUndefined();
  });

  it('clips a long why', () => {
    const verdict = parseVerdict(JSON.stringify({ react: true, emoji: '😂', why: 'x'.repeat(500) }));
    expect(verdict?.why.length).toBe(200);
  });
});

describe('prompts', () => {
  it('carries the guide and sets a high bar', () => {
    const system = buildSystemPrompt(GUIDE);
    expect(system).toContain(GUIDE.text);
    expect(system).toContain('when in doubt, don');
    expect(system).toContain('{"react": true or false');
    expect(buildSystemPrompt({ ...GUIDE, text: '' })).toContain('(no reaction history yet)');
  });

  it('shows the context, then the post with its notes', () => {
    const text = buildUserText(INPUT);
    expect(text).toContain('Recent messages (oldest first):\nDale: who is driving tonight\nFrigidaire (the bot): not me');
    expect(text).toContain('THE POST TO JUDGE, by Remi:\nI just parallel parked into a hydrant\n[reactions so far: 😂×2]');
    expect(text).toContain('(1 image(s) from the post attached)');
    expect(buildUserText({ ...INPUT, context: [] })).not.toContain('Recent messages');
  });
});

describe('createAutoReactJudge', () => {
  it('asks the chat model once: ZDR-routed, tagged auto_react, low reasoning, images attached', async () => {
    const { client, requests } = createCapturingClient([
      { body: chatCompletionBody('{"react": true, "emoji": "KEKW", "why": "legendary fail"}') },
    ]);
    const judge = createAutoReactJudge({ client: () => client, model: () => 'z-ai/glm-5.3-flash' });
    expect(await judge(INPUT)).toEqual({ react: true, emoji: 'KEKW', why: 'legendary fail' });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.headers.get(FEATURE_HEADER)).toBe('auto_react');
    expect(request.body).toMatchObject({
      model: 'z-ai/glm-5.3-flash',
      provider: { zdr: true },
      reasoning: { effort: 'low' },
      response_format: { type: 'json_object' },
    });
    const messages = request.body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(String(messages[0].content)).toContain(':KEKW: (40×)');
    expect(messages[1].content).toEqual([
      { type: 'text', text: buildUserText(INPUT) },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ]);
  });

  it('returns undefined for an unreadable answer, an API error, or no key', async () => {
    const unreadable = createCapturingClient([{ body: chatCompletionBody('I think yes') }]);
    expect(await createAutoReactJudge({ client: () => unreadable.client })(INPUT)).toBeUndefined();

    const failing = createCapturingClient([{ status: 400, body: { error: { message: 'bad request', code: 400 } } }]);
    expect(await createAutoReactJudge({ client: () => failing.client })(INPUT)).toBeUndefined();

    expect(await createAutoReactJudge({ client: () => undefined })(INPUT)).toBeUndefined();
  });
});
