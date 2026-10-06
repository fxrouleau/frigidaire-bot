import { describe, expect, it, vi } from 'vitest';
import { chatCompletionBody, createCapturingClient } from '../test-support/capturingClient';
import { composeCaption, describeEmojiUsage, normalizeUsagePhrase, splitCaption } from './emojiCaptioner';
import { FEATURE_HEADER } from './usage';

describe('splitCaption / composeCaption', () => {
  it('splits the visual half from the "for …" half', () => {
    expect(splitCaption('crying cat with big eyes; for sadness, pleading')).toEqual({
      visual: 'crying cat with big eyes',
      meaning: 'for sadness, pleading',
    });
    // Only the first "; for" separates: a visual half can't contain one, a meaning half can.
    expect(splitCaption('a; b; for x; for y')).toEqual({ visual: 'a; b', meaning: 'for x; for y' });
    expect(splitCaption('odd; format')).toEqual({ visual: 'odd', meaning: 'format' });
    expect(splitCaption('  just a visual  ')).toEqual({ visual: 'just a visual', meaning: '' });
  });

  it('rebuilds a caption with a new meaning half', () => {
    const { visual } = splitCaption('crying cat with big eyes; for sadness, pleading');
    expect(composeCaption(visual, 'for resigned "bruh" at absurd moments')).toBe(
      'crying cat with big eyes; for resigned "bruh" at absurd moments',
    );
    expect(composeCaption('', 'for meh')).toBe('for meh');
  });
});

describe('normalizeUsagePhrase', () => {
  it('keeps a clean phrase as is', () => {
    expect(normalizeUsagePhrase('for meh, underwhelmed or mildly annoyed')).toBe('for meh, underwhelmed or mildly annoyed');
  });

  it('cleans quotes, periods, extra lines, emoji syntax and semicolons, and enforces "for"', () => {
    expect(normalizeUsagePhrase('"For resigned bruh moments."\nBecause people use it when…')).toBe(
      'for resigned bruh moments',
    );
    expect(normalizeUsagePhrase('mocking <:KEKW:123> laughter; at friends')).toBe('for mocking KEKW laughter, at friends');
    expect(normalizeUsagePhrase('formal occasions')).toBe('for formal occasions');
  });

  it('clips a long phrase on a word boundary', () => {
    const phrase = normalizeUsagePhrase(`for ${'really '.repeat(20)}long`);
    expect(phrase?.length).toBeLessThanOrEqual(80);
    expect(phrase?.endsWith('really')).toBe(true);
  });

  it('rejects nothing usable', () => {
    expect(normalizeUsagePhrase(undefined)).toBeUndefined();
    expect(normalizeUsagePhrase('  "" ')).toBeUndefined();
    expect(normalizeUsagePhrase('.')).toBeUndefined();
  });
});

describe('describeEmojiUsage', () => {
  const input = {
    id: '300000000000000001',
    name: 'SAJ',
    animated: false,
    caption: 'crying cat; for sadness, pleading',
    uses: ['- reacted to: "the printer is on fire again"', '- replying to "flight cancelled": ":SAJ:"'],
  };

  it('asks the usage model (GLM 5.3 by default) with the uses, text only: ZDR-routed, low effort, tagged emoji_caption', async () => {
    const { client, requests } = createCapturingClient([
      { body: chatCompletionBody('for resigned "bruh" at absurd moments') },
    ]);
    expect(await describeEmojiUsage({ ...input, client })).toBe('for resigned "bruh" at absurd moments');
    const [request] = requests;
    expect(request.headers.get(FEATURE_HEADER)).toBe('emoji_caption');
    expect(request.body).toMatchObject({
      model: 'z-ai/glm-5.3',
      provider: { zdr: true },
      reasoning: { effort: 'low' },
      max_tokens: 2000,
    });
    // GLM 5.3 reads no images: the current caption's visual half says what the emoji shows.
    const content = (request.body.messages as Array<{ content: unknown }>)[0].content as string;
    expect(typeof content).toBe('string');
    expect(content).toContain('The emoji is "SAJ"');
    expect(content).toContain('Its current caption is "crying cat; for sadness, pleading"');
    expect(content).toContain(input.uses.join('\n'));
  });

  it('takes another model from EMOJI_USAGE_CAPTION_MODEL', async () => {
    vi.stubEnv('EMOJI_USAGE_CAPTION_MODEL', 'some/other-model');
    const { client, requests } = createCapturingClient([{ body: chatCompletionBody('for hype') }]);
    await describeEmojiUsage({ ...input, client });
    expect(requests[0].body.model).toBe('some/other-model');
    vi.unstubAllEnvs();
  });

  it('returns undefined on an API error or an empty answer', async () => {
    const failing = createCapturingClient([{ status: 400, body: { error: { message: 'bad', code: 400 } } }]);
    expect(await describeEmojiUsage({ ...input, client: failing.client })).toBeUndefined();
    const empty = createCapturingClient([{ body: chatCompletionBody('') }]);
    expect(await describeEmojiUsage({ ...input, client: empty.client })).toBeUndefined();
  });
});
