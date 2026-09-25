import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveInput, snowflake } from '../test-support/fakeArchive';
import { ArchiveStore, compareSnowflakes, ftsTerms, normalizeReactions } from './archiveStore';

const CHANNEL = '100000000000000001';
const OTHER_CHANNEL = '100000000000000002';
const THREAD = '100000000000000003';
const FELIX = '200000000000000001';
const JASON = '200000000000000002';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 15, 17, 0);

let store: ArchiveStore;

beforeEach(() => {
  store = new ArchiveStore(':memory:');
});

afterEach(() => {
  store.close();
});

function ids(hits: { id: string }[]): string[] {
  return hits.map((h) => h.id);
}

describe('ArchiveStore — FTS consistency', () => {
  it('keeps the external-content index exact across insert, edit, delete, transcript and relay updates', () => {
    const a = archiveInput({ id: snowflake(T0, 1), content: 'pizza tonight at the usual place' });
    const b = archiveInput({ id: snowflake(T0, 2), content: 'who wants tacos', authorId: JASON, authorName: 'Jason' });
    const c = archiveInput({
      id: snowflake(T0, 3),
      content: '',
      hasAudio: true,
      source: 'relay',
      authorId: null,
      authorName: 'Jason',
    });
    store.upsertMessages([a, b, c]);
    store.checkFtsIntegrity();
    expect(ids(store.search('pizza', {}, 10).hits)).toEqual([a.id]);

    // Edit: the old words leave the index, the new ones arrive.
    store.upsertMessage({ ...a, content: 'burgers tonight instead', editedAt: T0 + 60_000 });
    store.checkFtsIntegrity();
    expect(store.search('pizza', {}, 10).hits).toHaveLength(0);
    expect(ids(store.search('burgers', {}, 10).hits)).toEqual([a.id]);

    // Transcript and relay attribution arrive later; both are indexed columns.
    expect(store.setTranscript(c.id, 'bring the charcoal')).toBe(true);
    expect(store.setRelayInfo(c.id, { authorId: JASON, authorName: 'Jason R', relayKind: 'regret' })).toBe(true);
    store.checkFtsIntegrity();
    expect(ids(store.search('charcoal', {}, 10).hits)).toEqual([c.id]);

    // Delete twice (MessageDelete, then a bulk delete covering it): the second is a no-op, not a
    // second FTS 'delete' — the pattern that corrupted the memory store's index.
    expect(store.markDeleted([b.id], T0 + DAY)).toBe(1);
    expect(store.markDeleted([b.id, 'unknown-id'], T0 + DAY)).toBe(0);
    store.checkFtsIntegrity();
    expect(store.search('tacos', {}, 10).hits).toHaveLength(0);

    // Channel deletion scrubs the rest.
    expect(store.markChannelDeleted(CHANNEL, T0 + 2 * DAY)).toBe(2);
    store.checkFtsIntegrity();
    expect(store.search('burgers charcoal', {}, 10).hits).toHaveLength(0);

    store.rebuildFtsIndex();
    store.checkFtsIntegrity();
  });

  it('has an integrity check that catches a mismatched manual FTS delete (so the test above is meaningful)', () => {
    store.upsertMessage(archiveInput({ content: 'hello world' }));
    store.db
      .prepare(
        "INSERT INTO messages_fts(messages_fts, rowid, content, author_name, transcript, extra_text) VALUES ('delete', 1, 'other words', 'x', NULL, '')",
      )
      .run();
    expect(() => store.checkFtsIntegrity()).toThrow();
    store.rebuildFtsIndex();
    store.checkFtsIntegrity();
  });

  it('scrubs a deleted message but keeps the row (author, times) for the stats', () => {
    const a = archiveInput({
      content: 'something regrettable',
      attachments: [{ name: 'pic.png', type: 'image/png', size: 10, url: 'https://cdn/pic.png' }],
      embeds: [{ title: 'A tweet' }],
      extraText: 'A tweet\npic.png',
      reactions: [{ id: null, name: '💀', count: 3 }],
    });
    store.upsertMessage(a);
    store.markDeleted([a.id], T0 + 5000);
    const row = store.getMessage(a.id);
    expect(row).toMatchObject({
      content: '',
      extraText: '',
      transcript: null,
      attachments: [],
      embeds: [],
      reactions: [],
      deletedAt: T0 + 5000,
      authorId: FELIX,
    });
  });

  it('never resurrects a deleted message on a later upsert (gap fill overlap)', () => {
    const a = archiveInput({ content: 'gone soon' });
    store.upsertMessage(a);
    store.markDeleted([a.id], T0 + 1000);
    expect(store.upsertMessage(a)).toBe(false);
    expect(store.getMessage(a.id)?.content).toBe('');
    store.checkFtsIntegrity();
  });
});

describe('ArchiveStore — upsert semantics', () => {
  it('is a no-op for an unchanged re-ingest and reports new rows per batch', () => {
    const a = archiveInput({ id: snowflake(T0, 1), content: 'hello' });
    const b = archiveInput({ id: snowflake(T0, 2), content: 'world' });
    expect(store.upsertMessages([a])).toBe(1);
    expect(store.upsertMessage(a)).toBe(false);
    expect(store.upsertMessages([a, b])).toBe(1);
    expect(store.countMessages()).toBe(2);
  });

  it('counts one edit per newer edited timestamp', () => {
    const a = archiveInput({ content: 'v1' });
    store.upsertMessage(a);
    store.upsertMessage({ ...a, content: 'v2', editedAt: T0 + 1000 });
    store.upsertMessage({ ...a, content: 'v2', editedAt: T0 + 1000 }); // replayed update
    store.upsertMessage({ ...a, content: 'v3', editedAt: T0 + 2000 });
    expect(store.getMessage(a.id)).toMatchObject({ content: 'v3', editCount: 2, editedAt: T0 + 2000 });
  });

  it('counts a message first seen already edited (backfill) as edited once', () => {
    const a = archiveInput({ content: 'old edit', editedAt: T0 + 1000 });
    store.upsertMessage(a);
    expect(store.getMessage(a.id)?.editCount).toBe(1);
  });

  it('keeps a known transcript and author when a later ingest lacks them', () => {
    const a = archiveInput({ hasAudio: true, transcript: 'hello there' });
    store.upsertMessage(a);
    store.upsertMessage({ ...a, transcript: null, authorId: null, extraText: 'late embed' });
    expect(store.getMessage(a.id)).toMatchObject({ transcript: 'hello there', authorId: FELIX, extraText: 'late embed' });
  });

  it('stores reactions in canonical order and treats a reordered set as unchanged', () => {
    const a = archiveInput({
      reactions: [
        { id: null, name: '😂', count: 2 },
        { id: '300000000000000001', name: 'kekw', count: 1, me: true },
      ],
    });
    store.upsertMessage(a);
    expect(store.upsertMessage({ ...a, reactions: [...a.reactions].reverse() })).toBe(false);
    expect(store.getMessage(a.id)?.reactions).toEqual(normalizeReactions(a.reactions));
    expect(store.upsertMessage({ ...a, reactions: [{ id: null, name: '😂', count: 3 }] })).toBe(true);
    expect(store.getReactions(a.id)).toEqual([{ id: null, name: '😂', count: 3 }]);
    store.checkFtsIntegrity();
  });
});

describe('ArchiveStore — search', () => {
  it('ranks all-terms matches before any-term matches, and ignores stop words in the any tier', () => {
    const both = archiveInput({ id: snowflake(T0, 1), content: 'the new league patch is out' });
    const one = archiveInput({ id: snowflake(T0, 2), content: 'league tonight?' });
    const stop = archiveInput({ id: snowflake(T0, 3), content: 'the the the' });
    store.upsertMessages([both, one, stop]);
    const result = store.search('the league patch', {}, 10);
    expect(result.hits.map((h) => [h.id, h.tier])).toEqual([
      [both.id, 'all'],
      [one.id, 'any'],
    ]);
  });

  it('treats FTS5 operators and punctuation in the query as plain words', () => {
    store.upsertMessage(archiveInput({ content: 'near and or not: all plain words' }));
    expect(() => store.search('"NEAR( AND OR * ^ -not col:umn', {}, 10)).not.toThrow();
    expect(store.search('NEAR AND', {}, 10).hits).toHaveLength(1);
    expect(store.search('" * : ^', {}, 10).hits).toHaveLength(0);
  });

  it('stems and folds diacritics', () => {
    store.upsertMessage(archiveInput({ content: 'he was running late, déjà vu' }));
    expect(store.search('runs', {}, 10).hits).toHaveLength(1);
    expect(store.search('deja', {}, 10).hits).toHaveLength(1);
  });

  it('searches transcripts and link-preview text, and weighs recency between equally relevant hits', () => {
    const old = archiveInput({ id: snowflake(T0 - 400 * DAY), createdAt: T0 - 400 * DAY, content: 'baron steal' });
    const recent = archiveInput({ id: snowflake(T0 - DAY), createdAt: T0 - DAY, content: 'baron steal' });
    const voice = archiveInput({ id: snowflake(T0, 5), hasAudio: true, transcript: 'what a baron steal' });
    const embed = archiveInput({ id: snowflake(T0, 6), extraText: 'Insane baron steal compilation' });
    store.upsertMessages([old, recent, voice, embed]);
    const hits = ids(store.search('baron steal', {}, 10, T0).hits);
    expect(hits).toHaveLength(4);
    expect(hits.indexOf(recent.id)).toBeLessThan(hits.indexOf(old.id));
  });

  it('applies author, bot, channel (threads included), visibility and time filters; never returns deleted rows', () => {
    const felix = archiveInput({ id: snowflake(T0, 1), content: 'cheese', createdAt: T0 });
    const jason = archiveInput({ id: snowflake(T0, 2), content: 'cheese', authorId: JASON, authorName: 'Jason' });
    const legacy = archiveInput({
      id: snowflake(T0, 3),
      content: 'cheese',
      authorId: null,
      authorName: 'OldTimer',
      source: 'relay',
    });
    const bot = archiveInput({ id: snowflake(T0, 4), content: 'cheese', authorId: 'bot', source: 'bot' });
    const thread = archiveInput({ id: snowflake(T0, 5), content: 'cheese', channelId: THREAD, parentChannelId: CHANNEL });
    const other = archiveInput({ id: snowflake(T0 + DAY), createdAt: T0 + DAY, content: 'cheese', channelId: OTHER_CHANNEL });
    const deleted = archiveInput({ id: snowflake(T0, 7), content: 'cheese' });
    store.upsertMessages([felix, jason, legacy, bot, thread, other, deleted]);
    store.markDeleted([deleted.id], T0 + 1);

    const search = (filters: Parameters<ArchiveStore['search']>[1]) => ids(store.search('cheese', filters, 20).hits).sort();

    expect(search({})).toHaveLength(6);
    expect(search({ authorIds: [JASON] })).toEqual([jason.id]);
    expect(search({ authorIds: [], authorNames: ['oldtimer'] })).toEqual([legacy.id]);
    expect(search({ botOnly: true })).toEqual([bot.id]);
    expect(search({ channelIds: [CHANNEL] })).toEqual([felix.id, jason.id, legacy.id, bot.id, thread.id].sort());
    expect(search({ allowedChannelIds: [OTHER_CHANNEL] })).toEqual([other.id]);
    expect(search({ afterMs: T0 + 1000 })).toEqual([other.id]);
    expect(search({ beforeMs: T0 + 1000, channelIds: [OTHER_CHANNEL] })).toEqual([]);
  });

  it('returns nothing for a query without searchable terms', () => {
    store.upsertMessage(archiveInput({ content: 'a' }));
    expect(store.search('a !', {}, 10)).toEqual({ hits: [], truncated: false });
  });

  it('lists the latest messages for a filter-only query, oldest first, with the total', () => {
    const inputs = [0, 1, 2, 3].map((i) =>
      archiveInput({ id: snowflake(T0 + i * 1000), createdAt: T0 + i * 1000, content: `m${i}` }),
    );
    store.upsertMessages(inputs);
    const { messages, total } = store.listRecent({ authorIds: [FELIX] }, 2);
    expect(total).toBe(4);
    expect(messages.map((m) => m.content)).toEqual(['m2', 'm3']);
  });
});

describe('ArchiveStore — reads', () => {
  function seedTimeline() {
    const inputs = [0, 1, 2, 3, 4].map((i) =>
      archiveInput({ id: snowflake(T0 + i * 1000), createdAt: T0 + i * 1000, content: `m${i}` }),
    );
    const elsewhere = archiveInput({ id: snowflake(T0 + 2500), createdAt: T0 + 2500, channelId: OTHER_CHANNEL });
    const inThread = archiveInput({
      id: snowflake(T0 + 2600),
      createdAt: T0 + 2600,
      channelId: THREAD,
      parentChannelId: CHANNEL,
      content: 'thread',
    });
    store.upsertMessages([...inputs, elsewhere, inThread]);
    return inputs;
  }

  it('returns the surrounding messages of the same channel, deleted ones excluded', () => {
    const inputs = seedTimeline();
    store.markDeleted([inputs[1].id], T0 + DAY);
    const target = store.getMessage(inputs[2].id);
    if (!target) throw new Error('missing target');
    const window = store.getContext(target, 2, 1);
    expect(window.before.map((m) => m.content)).toEqual(['m0']);
    expect(window.after.map((m) => m.content)).toEqual(['m3']);
  });

  it("returns a channel's messages in [start, end), oldest first, optionally with its threads", () => {
    const inputs = seedTimeline();
    expect(store.getChannelMessages(CHANNEL, T0 + 1000, T0 + 4000).map((m) => m.content)).toEqual(['m1', 'm2', 'm3']);
    expect(
      store.getChannelMessages(CHANNEL, T0 + 2000, T0 + 3000, { includeThreads: true }).map((m) => m.content),
    ).toEqual(['m2', 'thread']);
    expect(store.oldestMessage(CHANNEL)?.id).toBe(inputs[0].id);
    expect(store.newestMessage(CHANNEL)?.id).toBe(inputs[4].id);
    expect(store.channelsWithHistory().map((c) => c.channelId).sort()).toEqual([CHANNEL, OTHER_CHANNEL, THREAD].sort());
    expect(store.oldestTimestamp()).toBe(T0);
    expect(store.sizeBytes()).toBeGreaterThan(0);
  });

  it('knows when it is empty', () => {
    expect(store.isEmpty()).toBe(true);
    store.upsertMessage(archiveInput());
    expect(store.isEmpty()).toBe(false);
  });

  it('keeps channel rows and finds archived author names', () => {
    store.upsertChannel({ id: CHANNEL, guildId: 'g', name: 'banana-combo', parentId: null, type: 0 }, T0);
    store.upsertChannel({ id: CHANNEL, guildId: 'g', name: 'banana-combo', parentId: null, type: 0 }, T0 + 1);
    expect(store.getChannel(CHANNEL)?.updatedAt).toBe(T0); // unchanged ⇒ not rewritten
    store.upsertChannel({ id: CHANNEL, guildId: 'g', name: 'renamed', parentId: null, type: 0 }, T0 + 2);
    expect(store.listChannels().map((c) => c.name)).toEqual(['renamed']);

    store.upsertMessage(archiveInput({ authorId: null, authorName: 'Ghosty', source: 'relay' }));
    expect(store.findAuthorsByName('ghosty', 'exact')).toEqual([{ authorId: null, authorName: 'Ghosty' }]);
    expect(store.findAuthorsByName('host', 'substring')).toHaveLength(1);
  });

  it('lists pending transcripts and unresolved relays within the lookback', () => {
    const voice = archiveInput({ id: snowflake(T0, 1), hasAudio: true });
    const relay = archiveInput({ id: snowflake(T0, 2), source: 'relay', relayKind: null });
    const oldVoice = archiveInput({ id: snowflake(T0 - 90 * DAY), createdAt: T0 - 90 * DAY, hasAudio: true });
    store.upsertMessages([voice, relay, oldVoice]);
    expect(store.pendingTranscriptIds(T0 - DAY, 10)).toEqual([voice.id]);
    expect(store.unresolvedRelayIds(T0 - DAY, 10)).toEqual([relay.id]);
  });
});

describe('ArchiveStore — backfill state', () => {
  it('advances the cursor with each page in one transaction, and keeps it through errors', () => {
    const page = [archiveInput({ id: snowflake(T0, 1) }), archiveInput({ id: snowflake(T0, 2) })];
    const added = store.saveBackfillPage(CHANNEL, page, {
      cursorId: page[0].id,
      cursorAt: T0,
      fetched: 2,
      done: false,
    });
    expect(added).toBe(2);
    store.recordBackfillError(CHANNEL, 'boom', T0 + 1);
    expect(store.getBackfillState(CHANNEL)).toMatchObject({
      cursorId: page[0].id,
      pages: 1,
      fetched: 2,
      done: false,
      lastError: 'boom',
      errorAt: T0 + 1,
    });

    // An empty last page keeps the cursor and marks the channel done; the error is cleared.
    store.saveBackfillPage(CHANNEL, [], { cursorId: null, cursorAt: null, fetched: 0, done: true }, T0 + 2);
    expect(store.getBackfillState(CHANNEL)).toMatchObject({
      cursorId: page[0].id,
      pages: 2,
      done: true,
      lastError: null,
    });
    expect(store.listBackfillStates()).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('orders snowflakes numerically beyond 2^53', () => {
    expect(compareSnowflakes('9', '10')).toBe(-1);
    expect(compareSnowflakes('1234567890123456789', '1234567890123456788')).toBe(1);
    expect(compareSnowflakes('5', '5')).toBe(0);
  });

  it('extracts distinct searchable terms', () => {
    expect(ftsTerms('"Pizza" AND pizza* -tacos (x) é')).toEqual(['pizza', 'and', 'tacos']);
  });
});
