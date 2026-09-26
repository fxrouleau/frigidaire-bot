// Memory v2 capture end to end: a channel log with Discord's fetch semantics in, a capturing OpenRouter
// client out. The whole conversation is read (paged past 100 messages), split into parts at quiet gaps
// when it is too long, cited evidence and related members are stored, and the extractor knows the
// participants' notes. The pre-v2 cycle behaviors are in personalityLearner.observe.test.ts.
import { type Channel, type Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import {
  type CapturedRequest,
  chatCompletionBody,
  createCapturingClient,
  type ScriptedReply,
} from '../test-support/capturingClient';
import { createFakeClient, createFakeMessage } from '../test-support/fakeDiscord';
import { type CaptureTrigger, ConversationEndTrigger } from './captureTrigger';
import { setMemoryStoreForTesting, setNotesStoreForTesting } from './memory';
import { parseEvidence } from './memory/evidence';
import { MemoryStore, relatedUserIdsOf } from './memory/memoryStore';
import { NotesStore } from './memory/notes/notesStore';
import { type CaptureSizes, PersonalityLearner } from './personalityLearner';

vi.mock('./media', () => ({
  getCachedTranscript: () => undefined,
  transcribeAudio: async () => undefined,
}));

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const CHANNEL = '200000000000000001';
const MIN = 60_000;
const BASE = new Date('2026-09-01T14:00:00Z').getTime();
const idAt = (i: number) => String(500_000_000_000_000_000n + BigInt(i));

let store: MemoryStore;
let notes: NotesStore;

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  store = new MemoryStore(':memory:');
  notes = new NotesStore(store, { now: () => new Date(BASE) });
  setMemoryStoreForTesting(store);
  setNotesStoreForTesting(store, notes);
  vi.stubEnv('SELF_IMPROVEMENT_ENABLED', 'false');
  store.upsertIdentity(REMI, 'Remi');
  store.upsertIdentity(DALE, 'Dale');
  store.upsertIdentity(NOVA, 'Nova');
});

afterEach(() => {
  setBotDbForTesting(undefined);
  setMemoryStoreForTesting(undefined);
  vi.unstubAllEnvs();
});

const NAMES: Record<string, string> = { [REMI]: 'Remi', [DALE]: 'Dale', [NOVA]: 'Nova' };

/** Message i by `author`, posted `minutes` after BASE. */
function post(i: number, author: string, minutes: number, content = `message ${i}`): Message {
  return createFakeMessage({
    messageId: idAt(i),
    createdAt: new Date(BASE + minutes * MIN),
    channelId: CHANNEL,
    authorId: author,
    authorDisplayName: NAMES[author],
    content,
  }).message;
}

/** `count` messages from i = `from`, alternating Remi and Dale, one a minute from `startMinute`. */
function chat(from: number, count: number, startMinute: number, text = (i: number) => `message ${i}`): Message[] {
  return Array.from({ length: count }, (_, k) => {
    const i = from + k;
    return post(i, k % 2 === 0 ? REMI : DALE, startMinute + k, text(i));
  });
}

/** A ready client whose one text channel serves `log` with Discord's list-fetch semantics. */
function clientServing(log: Message[]) {
  const fake = createFakeMessage({ channelId: CHANNEL, channelName: 'general', channelMessages: log });
  const { client } = createFakeClient({ channelsById: { [CHANNEL]: fake.message.channel as unknown as Channel } });
  return { client, fetches: fake.recorders.messagesFetch.calls };
}

/** A trigger that hands out whatever the test queues, and records backlogs. */
function manualTrigger() {
  const backlog: { channelId: string; at: number }[] = [];
  let due: string[] = [];
  const trigger: CaptureTrigger = {
    tickMs: MIN,
    describe: () => 'manual',
    noteActivity: () => {},
    noteBacklog: (channelId, at) => backlog.push({ channelId, at }),
    takeDue: () => {
      const taken = due;
      due = [];
      return taken;
    },
  };
  return { trigger, backlog, queue: (...channels: string[]) => due.push(...channels) };
}

function learnerWith(replies: ScriptedReply[], opts: { sizes?: CaptureSizes; minMessages?: number } = {}) {
  const { client, requests } = createCapturingClient(replies);
  const manual = manualTrigger();
  const learner = new PersonalityLearner(store, {
    client,
    trigger: manual.trigger,
    minMessages: opts.minMessages ?? 3,
    idleMs: 20 * MIN,
    sizes: opts.sizes,
  });
  manual.queue(CHANNEL);
  return { learner, requests, ...manual };
}

const reply = (output: unknown): ScriptedReply => ({ body: chatCompletionBody(JSON.stringify(output)) });
const nothing = () => reply({ observations: [] });

type Part = { type: string; text?: string; image_url?: { url: string } };
const partsOf = (request: CapturedRequest) => (request.body.messages as { content: Part[] }[])[0].content;
/** The transcript lines of a request (everything after the prompt). */
const linesOf = (request: CapturedRequest) =>
  partsOf(request)
    .slice(1)
    .map((p) => p.text ?? '');
const promptOf = (request: CapturedRequest) => partsOf(request)[0].text ?? '';

describe('capture reads the whole conversation', () => {
  it('pages past the 100-message fetch and sends it in one request with numbered lines', async () => {
    store.setLastObserved(CHANNEL, idAt(0));
    const { client, fetches } = clientServing([post(0, REMI, 0), ...chat(1, 250, 10)]);
    const { learner, requests } = learnerWith([nothing()]);

    await learner.observeOnce(client, BASE + 300 * MIN);

    expect(fetches.map(([opts]) => opts)).toEqual([
      { limit: 100, after: idAt(0) },
      { limit: 100, after: idAt(100) },
      { limit: 100, after: idAt(200) },
    ]);
    expect(requests).toHaveLength(1);
    const lines = linesOf(requests[0]);
    expect(lines).toHaveLength(250);
    expect(lines[0]).toBe(`#1 [2026-09-01 10:10] [Remi (id:${REMI})] message 1`);
    expect(lines[249]).toMatch(/^#250 \[.*\] \[Dale \(id:100000000000000002\)\] message 250$/);
    expect(store.getLastObserved(CHANNEL)).toBe(idAt(250));
  });

  it('splits a long conversation at its quiet gap; the later part opens with an already-covered lead-in', async () => {
    store.setLastObserved(CHANNEL, idAt(0));
    // Two stretches of 30 messages with a 12-minute pause between them; room for about 40 per request.
    const log = [post(0, REMI, 0), ...chat(1, 30, 10), ...chat(31, 30, 52)];
    const { client } = clientServing(log);
    const { learner, requests } = learnerWith([nothing(), nothing()], { sizes: { segmentMaxChars: 40 * 60, leadInChars: 150 } });

    await learner.observeOnce(client, BASE + 300 * MIN);

    expect(requests).toHaveLength(2);
    const first = linesOf(requests[0]);
    expect(first).toHaveLength(30);
    expect(first[29]).toContain('message 30');
    expect(first.join('\n')).not.toContain('ALREADY COVERED');

    const second = linesOf(requests[1]);
    expect(second[0]).toMatch(/^## ALREADY COVERED — context only, do not extract/);
    expect(second[1]).toMatch(/^#1 .* message 29$/);
    expect(second[2]).toMatch(/^#2 .* message 30$/);
    expect(second[3]).toBe('## THE CONVERSATION CONTINUES — extract from here');
    expect(second[4]).toMatch(/^#3 .* message 31$/);
    expect(second.at(-1)).toMatch(/^#32 .* message 60$/);
    // Both prompts say what the lead-in is.
    expect(promptOf(requests[1])).toContain('A part headed "ALREADY COVERED"');
    expect(store.getLastObserved(CHANNEL)).toBe(idAt(60));
  });

  it('keeps the watermark after the last finished part when a later part fails', async () => {
    store.setLastObserved(CHANNEL, idAt(0));
    const { client } = clientServing([post(0, REMI, 0), ...chat(1, 30, 10), ...chat(31, 30, 52)]);
    const { learner, requests, queue } = learnerWith([nothing(), { error: new Error('network down') }], {
      sizes: { segmentMaxChars: 40 * 60 },
    });

    await learner.observeOnce(client, BASE + 300 * MIN);

    expect(requests).toHaveLength(2);
    expect(store.getLastObserved(CHANNEL)).toBe(idAt(30));
    // The next capture starts where the failed part did.
    const { client: again, fetches } = clientServing([post(0, REMI, 0), ...chat(1, 30, 10), ...chat(31, 30, 52)]);
    queue(CHANNEL);
    await expect(learner.observeOnce(again, BASE + 400 * MIN)).resolves.toBeUndefined();
    expect(fetches[0]).toEqual([{ limit: 100, after: idAt(30) }]);
  });

  it('stops at its cap and reports the rest as a backlog', async () => {
    store.setLastObserved(CHANNEL, idAt(0));
    const { client } = clientServing([post(0, REMI, 0), ...chat(1, 150, 10)]);
    const { learner, requests, backlog } = learnerWith([nothing()], { sizes: { maxMessages: 100 } });

    await learner.observeOnce(client, BASE + 300 * MIN);

    expect(linesOf(requests[0])).toHaveLength(100);
    expect(store.getLastObserved(CHANNEL)).toBe(idAt(100));
    expect(backlog).toEqual([{ channelId: CHANNEL, at: BASE + 300 * MIN }]);
  });

  it('steps over a full read with hardly any member messages instead of rereading it forever', async () => {
    store.setLastObserved(CHANNEL, idAt(0));
    const flood = Array.from({ length: 100 }, (_, k) =>
      createFakeMessage({
        messageId: idAt(k + 1),
        createdAt: new Date(BASE + (k + 1) * MIN),
        channelId: CHANNEL,
        authorId: 'music-bot',
        authorIsBot: true,
        content: 'Now playing',
      }).message,
    );
    const { client } = clientServing([post(0, REMI, 0), ...flood, ...chat(101, 5, 200)]);
    const { learner, requests, backlog } = learnerWith([], { sizes: { maxMessages: 100 } });

    await learner.observeOnce(client, BASE + 300 * MIN);

    expect(requests).toHaveLength(0);
    expect(store.getLastObserved(CHANNEL)).toBe(idAt(100));
    expect(backlog.map((b) => b.channelId)).toEqual([CHANNEL]);
  });

  it("reads only a never-captured channel's last conversation", async () => {
    const log = [...chat(1, 10, 0, (i) => `old ${i}`), ...chat(11, 5, 240, (i) => `new ${i}`)];
    const { client } = clientServing(log);
    const { learner, requests } = learnerWith([nothing()]);

    await learner.observeOnce(client, BASE + 300 * MIN);

    const lines = linesOf(requests[0]).join('\n');
    expect(lines).toContain('new 11');
    expect(lines).not.toContain('old ');
    expect(store.getLastObserved(CHANNEL)).toBe(idAt(15));
  });
});

describe('capture keeps what it cites', () => {
  it('stores the cited messages, a verified quote, the related members and when it was said', async () => {
    store.setLastObserved(CHANNEL, idAt(0));
    const log = [
      post(0, REMI, 0),
      post(1, REMI, 10, 'anyone up for drafts friday'),
      post(2, DALE, 11, 'me and Remi are driving to Quebec City for the long weekend'),
      post(3, REMI, 12, 'yeah road trip, leaving saturday at 6'),
      post(4, NOVA, 13, 'I start the bakery job on monday'),
    ];
    const output = {
      observations: [
        {
          category: 'event',
          subject: 'Dale',
          subject_user_id: DALE,
          content: 'Road trip to Quebec City with Remi on the long weekend',
          evidence: { lines: [2, 3], quote: 'driving to Quebec City for the long weekend' },
          related_user_ids: [REMI, 'Nova-not-a-member', '100000000000000999'],
        },
        {
          category: 'fact',
          subject: 'Nova',
          subject_user_id: NOVA,
          content: 'Starts a bakery job',
          evidence: { lines: [1], quote: 'I start a job at the bakery' },
        },
        { category: 'preference', subject: 'Remi', subject_user_id: REMI, content: 'Likes drafts' },
      ],
    };
    const { client } = clientServing(log);
    const { learner } = learnerWith([reply(output)]);

    await learner.observeOnce(client, BASE + 300 * MIN);

    const rows = store.getAllActive();
    const trip = rows.find((m) => m.content.startsWith('Road trip'));
    expect(parseEvidence(trip?.evidence)).toEqual({
      messageIds: [idAt(2), idAt(3)],
      quote: 'driving to Quebec City for the long weekend',
    });
    expect(relatedUserIdsOf(trip ?? {})).toEqual([REMI]);
    // First seen when it was said (the newest cited message), not when the capture ran.
    expect(trip?.first_seen_at).toBe('2026-09-01 14:12:00');

    // An invented quote is dropped; the cited line stays.
    const job = rows.find((m) => m.content === 'Starts a bakery job');
    expect(parseEvidence(job?.evidence)).toEqual({ messageIds: [idAt(1)] });

    const drafts = rows.find((m) => m.content === 'Likes drafts');
    expect(drafts?.evidence ?? null).toBeNull();
    expect(drafts?.related_user_ids ?? null).toBeNull();
  });

  it('puts a relationship row in every member’s journal', async () => {
    store.setLastObserved(CHANNEL, idAt(0));
    const output = {
      observations: [
        {
          category: 'fact',
          subject: 'Remi',
          subject_user_id: REMI,
          content: 'Best friends with Dale since high school',
          evidence: { lines: [1] },
          related_user_ids: ['Dale'],
        },
      ],
    };
    const { client } = clientServing([post(0, REMI, 0), ...chat(1, 3, 10)]);
    const { learner } = learnerWith([reply(output)]);

    await learner.observeOnce(client, BASE + 300 * MIN);

    const daleJournal = notes.newJournal({ scope: 'person', ownerId: DALE });
    expect(daleJournal.map((m) => m.content)).toEqual(['Best friends with Dale since high school']);
  });
});

describe('capture knows what is already known', () => {
  it("gives the extractor the participants' notes and the rows newer than them, and the people they talk about", async () => {
    await store.save({ category: 'fact', subject: 'Remi', subject_user_id: REMI, content: 'Works nights' });
    expect(
      notes.writeNotes(
        { scope: 'person', ownerId: REMI },
        [{ topic: 'profile', title: 'Remi', content: '## Now\nRuns the Friday drafts.\n\n## Earlier\n- Played Valorant.' }],
        { updatedBy: 'dream' },
      ).ok,
    ).toBe(true);
    notes.recordDreamSuccess({ scope: 'person', ownerId: REMI }, notes.journalHighWater());
    await store.save({ category: 'preference', subject: 'Remi', subject_user_id: REMI, content: 'Hates cilantro' });
    await store.save({ category: 'fact', subject: 'Nova', subject_user_id: NOVA, content: 'Plays the cello' });
    await store.save({ category: 'fact', subject: 'Dale', subject_user_id: DALE, content: 'Owns a husky' });

    store.setLastObserved(CHANNEL, idAt(0));
    const log = [
      post(0, REMI, 0),
      post(1, REMI, 10, 'drafts friday?'),
      post(2, DALE, 11, 'is Nova coming'),
      post(3, REMI, 12, 'she said maybe'),
    ];
    const { client } = clientServing(log);
    const { learner, requests } = learnerWith([nothing()]);

    await learner.observeOnce(client, BASE + 300 * MIN);

    const prompt = promptOf(requests[0]);
    expect(prompt).toContain(`Remi (id:${REMI}):\nYour notes`);
    expect(prompt).toContain('Runs the Friday drafts.');
    expect(prompt).not.toContain('Played Valorant');
    expect(prompt).not.toContain('Works nights');
    expect(prompt).toContain('- [preference] Remi: Hates cilantro');
    expect(prompt).toContain(`Dale (id:${DALE}):\n- [fact] Dale: Owns a husky`);
    // Nova didn't post, but the conversation is about her.
    expect(prompt).toContain(`Nova (id:${NOVA}):\n- [fact] Nova: Plays the cello`);
  });
});

describe('capture schedule', () => {
  it('captures a channel once its conversation has been quiet for the idle time', async () => {
    const { client: openai, requests } = createCapturingClient([nothing()]);
    const trigger = new ConversationEndTrigger({ idleMs: 20 * MIN, maxSpanMs: 120 * MIN, minMessages: 3 });
    const learner = new PersonalityLearner(store, { client: openai, trigger, minMessages: 3, idleMs: 20 * MIN });
    store.setLastObserved(CHANNEL, idAt(0));
    const log = [post(0, REMI, 0), ...chat(1, 4, 10)];
    for (const m of log.slice(1)) learner.trackActivity(CHANNEL, { at: m.createdTimestamp, messageId: m.id, authorId: m.author.id });
    const { client, fetches } = clientServing(log);

    await learner.observeOnce(client, BASE + 25 * MIN);
    expect(fetches).toHaveLength(0);

    await learner.observeOnce(client, BASE + 33 * MIN);
    expect([fetches.length, requests.length]).toEqual([1, 1]);
  });

  it('checks recently captured channels for messages missed while offline, except ignored ones', () => {
    vi.stubEnv('LEARNER_IGNORE_CHANNELS', '200000000000000009');
    store.setLastObserved(CHANNEL, idAt(1));
    store.setLastObserved('200000000000000009', idAt(2));
    const { trigger, backlog } = manualTrigger();
    const learner = new PersonalityLearner(store, { trigger });
    const { client } = createFakeClient();

    learner.start(client, Date.now());
    learner.stop();

    expect(backlog.map((b) => b.channelId)).toEqual([CHANNEL]);
    // Two weeks back at most.
    const later = manualTrigger();
    const restarted = new PersonalityLearner(store, { trigger: later.trigger });
    restarted.start(client, Date.now() + 15 * 24 * 60 * MIN);
    restarted.stop();
    expect(later.backlog).toEqual([]);
  });
});
