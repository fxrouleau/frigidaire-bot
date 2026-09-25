import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveStore } from '../archive/archiveStore';
import { archiveInput, snowflake } from '../test-support/fakeArchive';
import { type EmojiUsageSample, collectEmojiUsage, formatUsageSample, mixSamples } from './emojiUsage';

const SAJ = '300000000000000001';
const SMODGE = '300000000000000002';
const UNUSED = '300000000000000003';
const T0 = Date.UTC(2026, 0, 15, 17, 0);
const at = (minutes: number) => T0 + minutes * 60_000;

let store: ArchiveStore;

beforeEach(() => {
  store = new ArchiveStore(':memory:');
});

afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
});

describe('collectEmojiUsage', () => {
  it('counts reactions and typed uses, with the answered message for bare uses', () => {
    store.upsertMessages([
      archiveInput({ id: snowflake(at(0)), createdAt: at(0), content: 'my flight got cancelled for the third time' }),
      archiveInput({ id: snowflake(at(1)), createdAt: at(1), content: `<:SAJ:${SAJ}>`, authorName: 'Dale' }),
      archiveInput({ id: snowflake(at(2)), createdAt: at(2), content: 'the printer is on fire again' }),
      archiveInput({
        id: snowflake(at(3)),
        createdAt: at(3),
        content: `<:SAJ:${SAJ}> <:SAJ:${SAJ}>`,
        replyToId: snowflake(at(0)),
      }),
      archiveInput({
        id: snowflake(at(4)),
        createdAt: at(4),
        content: `honestly this whole week has been something else <:SAJ:${SAJ}>`,
      }),
      archiveInput({
        id: snowflake(at(5)),
        createdAt: at(5),
        content: 'they renamed the team again',
        reactions: [
          { id: SAJ, name: 'SAJ', count: 2 },
          { id: SMODGE, name: 'smodge', count: 1 },
        ],
      }),
      // Not uses: the id as plain text, a deleted message, the bot's own message.
      archiveInput({ id: snowflake(at(6)), createdAt: at(6), content: `emoji id ${SAJ} for reference` }),
      archiveInput({ id: snowflake(at(7)), createdAt: at(7), content: `<:SAJ:${SAJ}>`, source: 'bot' }),
      archiveInput({ id: snowflake(at(8)), createdAt: at(8), content: `<:SAJ:${SAJ}> deleted` }),
    ]);
    store.markDeleted([snowflake(at(8))], at(9));

    const usage = collectEmojiUsage([SAJ, SMODGE, UNUSED], { store });
    expect([...usage.keys()].sort()).toEqual([SAJ, SMODGE]);

    const saj = usage.get(SAJ);
    expect(saj).toMatchObject({ reactionUses: 2, messageUses: 3, total: 5 });
    expect(saj?.samples).toEqual([
      { kind: 'reaction', text: 'they renamed the team again' },
      { kind: 'message', text: 'honestly this whole week has been something else :SAJ:' },
      // A reply: the message it replied to, not the one right before it.
      { kind: 'message', text: ':SAJ: :SAJ:', before: 'my flight got cancelled for the third time' },
      // A bare use: the message right before it in the channel.
      { kind: 'message', text: ':SAJ:', before: 'my flight got cancelled for the third time' },
    ]);
    expect(usage.get(SMODGE)).toMatchObject({ reactionUses: 1, messageUses: 0, total: 1 });
  });

  it('is empty when the archive is off, and for no ids', () => {
    store.upsertMessage(archiveInput({ content: `<:SAJ:${SAJ}>` }));
    expect(collectEmojiUsage([], { store }).size).toBe(0);
    vi.stubEnv('ARCHIVE_ENABLED', 'false');
    expect(collectEmojiUsage([SAJ], { store }).size).toBe(0);
  });

  it('never puts a non-snowflake into the FTS query', () => {
    store.upsertMessage(archiveInput({ content: 'hello' }));
    expect(collectEmojiUsage(['" OR hello'], { store }).size).toBe(0);
  });

  it('leaves out ARCHIVE_IGNORE_CHANNELS (a parent covers its threads), rows archived before the ignore included', () => {
    const IGNORED = '100000000000000009';
    const IGNORED_THREAD = '100000000000000010';
    store.upsertMessages([
      archiveInput({
        id: snowflake(at(0)),
        createdAt: at(0),
        channelId: IGNORED,
        content: `private channel talk about the ban appeal <:SAJ:${SAJ}>`,
      }),
      archiveInput({
        id: snowflake(at(1)),
        createdAt: at(1),
        channelId: IGNORED_THREAD,
        parentChannelId: IGNORED,
        content: `private thread talk that goes on for a while <:SAJ:${SAJ}>`,
      }),
      archiveInput({
        id: snowflake(at(2)),
        createdAt: at(2),
        channelId: IGNORED,
        content: 'private post people reacted to',
        reactions: [{ id: SAJ, name: 'SAJ', count: 3 }],
      }),
      archiveInput({
        id: snowflake(at(3)),
        createdAt: at(3),
        content: `public use in the main channel, long enough <:SAJ:${SAJ}>`,
      }),
    ]);
    vi.stubEnv('ARCHIVE_IGNORE_CHANNELS', IGNORED);

    const saj = collectEmojiUsage([SAJ], { store }).get(SAJ);
    expect(saj).toMatchObject({ reactionUses: 0, messageUses: 1, total: 1 });
    expect(JSON.stringify(saj?.samples)).not.toContain('private');
  });

  it('caps the samples', () => {
    store.upsertMessages(
      Array.from({ length: 30 }, (_, i) =>
        archiveInput({ id: snowflake(at(i)), createdAt: at(i), content: `take ${i} was even worse than before <:SAJ:${SAJ}>` }),
      ),
    );
    const saj = collectEmojiUsage([SAJ], { store, maxSamples: 20 }).get(SAJ);
    expect(saj?.messageUses).toBe(30);
    expect(saj?.samples).toHaveLength(20);
    // Newest first.
    expect(saj?.samples[0].text).toContain('take 29');
  });
});

describe('mixSamples', () => {
  const r = (n: number): EmojiUsageSample[] => Array.from({ length: n }, (_, i) => ({ kind: 'reaction', text: `r${i}` }));
  const m = (n: number): EmojiUsageSample[] => Array.from({ length: n }, (_, i) => ({ kind: 'message', text: `m${i}` }));
  const kinds = (samples: EmojiUsageSample[]) => ({
    reactions: samples.filter((s) => s.kind === 'reaction').length,
    messages: samples.filter((s) => s.kind === 'message').length,
  });

  it('splits in proportion to usage, keeping a few of each kind', () => {
    expect(kinds(mixSamples(r(20), m(20), 90, 10, 20))).toEqual({ reactions: 17, messages: 3 });
    expect(kinds(mixSamples(r(20), m(20), 50, 50, 20))).toEqual({ reactions: 10, messages: 10 });
  });

  it('gives what one side cannot fill to the other', () => {
    expect(kinds(mixSamples(r(20), m(2), 10, 90, 20))).toEqual({ reactions: 18, messages: 2 });
    expect(kinds(mixSamples(r(1), m(20), 90, 10, 20))).toEqual({ reactions: 1, messages: 19 });
  });

  it('is empty without uses or room', () => {
    expect(mixSamples(r(3), m(3), 0, 0, 20)).toEqual([]);
    expect(mixSamples(r(3), m(3), 3, 3, 0)).toEqual([]);
  });
});

describe('formatUsageSample', () => {
  it('renders each kind as a prompt line', () => {
    expect(formatUsageSample({ kind: 'reaction', text: 'a' })).toBe('- reacted to: "a"');
    expect(formatUsageSample({ kind: 'message', text: 'b' })).toBe('- in a message: "b"');
    expect(formatUsageSample({ kind: 'message', text: 'c', before: 'd' })).toBe('- replying to "d": "c"');
  });
});
