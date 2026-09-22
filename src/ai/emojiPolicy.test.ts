import { describe, expect, it } from 'vitest';
import { applyEmojiPolicy, hasCustomEmoji } from './emojiPolicy';

const TROLLE = '<:trolle:111>';
const KEKW = '<a:kekw:222>';
const known = new Set(['111', '222']);

const quiet = { userMessageHadEmoji: false, recentBotEmojiReplies: 0, knownIds: known };

describe('hasCustomEmoji', () => {
  it('detects static and animated custom emoji tokens only', () => {
    expect(hasCustomEmoji(`hi ${TROLLE}`)).toBe(true);
    expect(hasCustomEmoji(`hi ${KEKW}`)).toBe(true);
    expect(hasCustomEmoji('hi 🙂')).toBe(false);
    expect(hasCustomEmoji('plain')).toBe(false);
  });
});

describe('applyEmojiPolicy', () => {
  it('leaves an emoji-free reply untouched', () => {
    expect(applyEmojiPolicy('just words', quiet)).toEqual({ text: 'just words', kept: [], stripped: [] });
  });

  it('allows a single known emoji when the bot has not used one recently', () => {
    expect(applyEmojiPolicy(`nice ${TROLLE}`, quiet)).toEqual({ text: `nice ${TROLLE}`, kept: [TROLLE], stripped: [] });
  });

  it('keeps at most one emoji', () => {
    const result = applyEmojiPolicy(`lol ${TROLLE} ${KEKW}`, quiet);
    expect(result.text).toBe(`lol ${TROLLE}`);
    expect(result.kept).toEqual([TROLLE]);
    expect(result.stripped).toEqual([KEKW]);
  });

  it('strips emojis the server does not have, even when one is allowed', () => {
    const result = applyEmojiPolicy(`hm <:ghost:999> ${KEKW}`, quiet);
    expect(result.text).toBe(`hm ${KEKW}`);
    expect(result.stripped).toEqual(['<:ghost:999>']);
  });

  it('strips every emoji when the bot used one recently and the user did not', () => {
    const result = applyEmojiPolicy(`again ${TROLLE}, wow.`, { ...quiet, recentBotEmojiReplies: 1 });
    expect(result.text).toBe('again, wow.');
    expect(result.stripped).toEqual([TROLLE]);
  });

  it('allows one emoji when the user message contained one (mirroring)', () => {
    const result = applyEmojiPolicy(`same ${TROLLE}`, { ...quiet, recentBotEmojiReplies: 3, userMessageHadEmoji: true });
    expect(result.text).toBe(`same ${TROLLE}`);
  });

  it('always allows a pure emoji reaction', () => {
    const result = applyEmojiPolicy(TROLLE, { ...quiet, recentBotEmojiReplies: 4 });
    expect(result.text).toBe(TROLLE);
    expect(result.kept).toEqual([TROLLE]);
  });

  it('tidies the whitespace left behind by a removed emoji', () => {
    const result = applyEmojiPolicy(`one ${TROLLE} two ${KEKW} !`, { ...quiet, recentBotEmojiReplies: 1 });
    expect(result.text).toBe('one two!');
  });

  it('skips the known-id check when the server emoji list is unknown', () => {
    const result = applyEmojiPolicy('yo <:ghost:999>', { userMessageHadEmoji: false, recentBotEmojiReplies: 0 });
    expect(result.text).toBe('yo <:ghost:999>');
  });

  it('never returns an empty reply: an all-unknown-emoji reply goes out unchanged', () => {
    const result = applyEmojiPolicy('<:ghost:999>', quiet);
    expect(result.text).toBe('<:ghost:999>');
    expect(result.stripped).toEqual([]);
  });
});
