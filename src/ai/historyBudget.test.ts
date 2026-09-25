import { describe, expect, it } from 'vitest';
import {
  IMAGE_PART_TOKENS,
  IMAGE_PLACEHOLDER,
  MAX_HISTORY_TOKENS,
  TRIMMED_NOTE,
  estimateEntryTokens,
  estimateTokens,
  historyBudgetFor,
  trimHistory,
} from './historyBudget';
import type { ConversationEntry } from './types';

const STATIC: ConversationEntry = { kind: 'message', role: 'developer', content: [{ type: 'text', text: 'persona' }] };

// 350 chars ≈ 100 estimated tokens.
const HUNDRED_TOKENS = 'x'.repeat(350);

function user(text = HUNDRED_TOKENS, images = 0): ConversationEntry {
  return {
    kind: 'message',
    role: 'user',
    content: [
      { type: 'text', text },
      ...Array.from({ length: images }, (_, i) => ({ type: 'image' as const, url: `https://img/${i}.png` })),
    ],
  };
}

function assistant(text = HUNDRED_TOKENS): ConversationEntry {
  return { kind: 'message', role: 'assistant', content: [{ type: 'text', text }] };
}

function call(id: string): ConversationEntry {
  return { kind: 'tool_call', id, name: 'echo_tool', arguments: { text: HUNDRED_TOKENS } };
}

function result(id: string): ConversationEntry {
  return { kind: 'tool_result', id, name: 'echo_tool', content: HUNDRED_TOKENS };
}

function texts(entries: ConversationEntry[]): string[] {
  return entries.map((e) => (e.kind === 'message' ? e.content.map((p) => (p.type === 'text' ? p.text : '<img>')).join('') : e.kind));
}

/** Every tool_call has its result and every result its call. */
function toolPairsIntact(entries: ConversationEntry[]): boolean {
  const calls = new Set(entries.filter((e) => e.kind === 'tool_call').map((e) => (e as { id: string }).id));
  const results = new Set(entries.filter((e) => e.kind === 'tool_result').map((e) => (e as { id: string }).id));
  return calls.size === results.size && [...calls].every((id) => results.has(id));
}

describe('historyBudgetFor', () => {
  it('is half the context window, capped at 500k', () => {
    expect(historyBudgetFor(163_840)).toBe(81_920);
    expect(historyBudgetFor(2_000_000)).toBe(MAX_HISTORY_TOKENS);
  });

  it('prefers an explicit override', () => {
    expect(historyBudgetFor(163_840, 5000)).toBe(5000);
  });
});

describe('estimateEntryTokens', () => {
  it('counts text at 3.5 chars per token and a flat cost per image', () => {
    expect(estimateEntryTokens(user(HUNDRED_TOKENS))).toBe(100);
    expect(estimateEntryTokens(user(HUNDRED_TOKENS, 2))).toBe(100 + 2 * IMAGE_PART_TOKENS);
    expect(estimateEntryTokens(result('a'))).toBe(100);
    expect(estimateEntryTokens(call('a'))).toBeGreaterThan(100);
  });
});

describe('trimHistory', () => {
  it('returns the very same array when under budget', () => {
    const entries = [STATIC, user(), assistant()];
    const result = trimHistory(entries, 10_000);
    expect(result.entries).toBe(entries);
    expect(result.dropped).toBe(0);
    expect(result.imagesReplaced).toBe(0);
  });

  it('first replaces images in the older half with a marker, and stops there when that is enough', () => {
    const entries = [STATIC, user('old', 2), assistant('a'), user('new', 1), assistant('b')];
    // 3 images ≈ 4500 tokens: over a 4000 budget, back under once the two old images are markers.
    const result = trimHistory(entries, 4000);

    expect(result.imagesReplaced).toBe(2);
    expect(result.dropped).toBe(0);
    const [, oldUser, , newUser] = result.entries;
    expect(oldUser.kind === 'message' && oldUser.content.map((p) => (p.type === 'text' ? p.text : 'img'))).toEqual([
      'old',
      IMAGE_PLACEHOLDER,
      IMAGE_PLACEHOLDER,
    ]);
    // The newer half keeps its image.
    expect(newUser.kind === 'message' && newUser.content.some((p) => p.type === 'image')).toBe(true);
    // No trimmed note: nothing was dropped.
    expect(texts(result.entries)).not.toContain(TRIMMED_NOTE);
  });

  it('drops the oldest entries down to ~75% of the budget and adds one trimmed note after the static prompt', () => {
    const entries = [STATIC, ...Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? user() : assistant()))];
    expect(estimateTokens(entries)).toBeGreaterThan(2000);

    const result = trimHistory(entries, 1000);

    expect(result.entries[0]).toBe(STATIC);
    expect(texts(result.entries)[1]).toBe(TRIMMED_NOTE);
    expect(result.tokensAfter).toBeLessThanOrEqual(750);
    expect(result.dropped).toBeGreaterThan(0);
    // What survives is the newest tail, in order.
    expect(result.entries.at(-1)).toBe(entries.at(-1));
  });

  it('keeps a single trimmed note across repeated trims', () => {
    const entries = [STATIC, ...Array.from({ length: 20 }, () => user())];
    const once = trimHistory(entries, 1000).entries;
    const grown = [...once, ...Array.from({ length: 10 }, () => user())];
    const twice = trimHistory(grown, 1000).entries;

    expect(texts(twice).filter((t) => t === TRIMMED_NOTE)).toHaveLength(1);
    expect(texts(twice)[1]).toBe(TRIMMED_NOTE);
  });

  it('never separates a tool_call from its tool_results', () => {
    const entries: ConversationEntry[] = [STATIC];
    for (let i = 0; i < 8; i++) {
      entries.push(user(), call(`c${i}a`), call(`c${i}b`), assistant('thinking'), result(`c${i}a`), result(`c${i}b`), assistant());
    }

    for (const budget of [600, 900, 1300, 2000, 3000]) {
      const trimmed = trimHistory(entries, budget).entries;
      expect(toolPairsIntact(trimmed)).toBe(true);
      // The remaining history never starts with an orphaned result.
      expect(trimmed[2]?.kind).not.toBe('tool_result');
    }
  });

  it('never drops the newest entry, even when it alone is over budget', () => {
    const huge = user('y'.repeat(35_000));
    const entries = [STATIC, user(), assistant(), huge];
    const result = trimHistory(entries, 1000);
    expect(result.entries.at(-1)).toBe(huge);
    expect(result.entries[0]).toBe(STATIC);
  });

  it('does not mutate the input entries', () => {
    const entries = [STATIC, user('old', 3), assistant(), user('new', 3), assistant()];
    const snapshot = structuredClone(entries);
    trimHistory(entries, 2000);
    expect(entries).toEqual(snapshot);
  });

  it('never touches the static prompt, however large', () => {
    const bigStatic: ConversationEntry = { kind: 'message', role: 'developer', content: [{ type: 'text', text: 'p'.repeat(7000) }] };
    const entries = [bigStatic, user(), assistant(), user()];
    const result = trimHistory(entries, 1000);
    expect(result.entries[0]).toBe(bigStatic);
    expect(result.entries.at(-1)).toBe(entries.at(-1));
  });
});
