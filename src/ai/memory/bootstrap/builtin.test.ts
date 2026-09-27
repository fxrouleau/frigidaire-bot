import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveStore } from '../../../archive/archiveStore';
import { logger } from '../../../logger';
import { chatCompletionBody, createCapturingClient, type ScriptedReply } from '../../../test-support/capturingClient';
import { archiveInput, snowflake } from '../../../test-support/fakeArchive';
import { FEATURE_HEADER } from '../../usage';
import { MemoryStore } from '../memoryStore';
import type { NightlyDreamResult } from '../notes/dreamer';
import { NotesStore } from '../notes/notesStore';
import {
  BOOTSTRAP_PROGRESS_KEY,
  type BootstrapSegment,
  buildBootstrapPrompt,
  estimateBootstrap,
  parseBootstrapAnswer,
  planBootstrap,
  type ParsedBootstrapAnswer,
  readProgress,
  runBootstrap,
  splitSegment,
} from './builtin';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const REMI_ALT = '100000000000000011';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const GENERAL = '300000000000000001';
const MODEL = 'anthropic/claude-opus-5.5';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// 2019-03-01 19:00 Eastern.
const MARCH = Date.UTC(2019, 2, 2, 0, 0);
const APRIL = Date.UTC(2019, 3, 2, 0, 0);

let memory: MemoryStore;
let notes: NotesStore;
let archive: ArchiveStore;
let n = 0;

beforeEach(() => {
  vi.stubEnv('LINKED_ACCOUNTS', `${REMI_ALT}:${REMI}`);
  memory = new MemoryStore(':memory:');
  notes = new NotesStore(memory);
  archive = new ArchiveStore(':memory:');
  memory.upsertIdentity(REMI, 'Remi', 'remi_b');
  memory.upsertIdentity(DALE, 'Dale', 'dale_d');
  memory.upsertIdentity(NOVA, 'Nova', 'nova_n');
  archive.upsertChannel({ id: GENERAL, guildId: null, name: 'general', parentId: null, type: 0 });
  vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  memory.close();
  archive.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function say(at: number, authorId: string, authorName: string, content: string): string {
  const id = snowflake(at, n++ % 4000);
  archive.upsertMessage(archiveInput({ id, channelId: GENERAL, authorId, authorName, content, createdAt: at }));
  return id;
}

/** Two months of fictional chat. Returns the id of the message that reveals Remi's job. */
function seedHistory(): string {
  say(MARCH, DALE, 'Dale', 'how was the first week');
  const job = say(MARCH + MIN, REMI, 'Remi', 'the bakery shift starts at 5am, i am dying');
  say(MARCH + 2 * MIN, NOVA, 'Nova', 'rip remi');
  say(APRIL, REMI, 'Remi', 'bakery again at 5am lol');
  say(APRIL + MIN, DALE, 'Dale', 'you love it');
  return job;
}

function answer(observations: unknown[]): ScriptedReply {
  return { body: { ...(chatCompletionBody(JSON.stringify({ observations })) as object), usage: { cost: 0.0125 } } };
}

/** An answer the model had to stop at the output limit: JSON cut off mid-list. */
function cutOff(): ScriptedReply {
  const content = `{"observations": [{"category": "fact", "subject_user_id": "${REMI}", "content": "Works early shifts at a bakery.", "date": "2019-03-01"}, {"category": "fact", "subject_user_id": "${DALE}", "content": "Ask`;
  return {
    body: {
      ...(chatCompletionBody(content) as object),
      choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content } }],
      usage: { cost: 0.2 },
    },
  };
}

/** The observations of an answer that parsed. */
function accepted(result: ParsedBootstrapAnswer): Extract<ParsedBootstrapAnswer, { ok: true }> {
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result;
}

function promptOf(request: { body: Record<string, unknown> }): string {
  return (request.body.messages as { content: string }[])[0].content;
}

describe('planBootstrap', () => {
  it('reads the archive month by month, oldest first, with stable keys', () => {
    const job = seedHistory();
    const plan = planBootstrap(archive, memory);
    expect(plan.months).toBe(2);
    expect(plan.messages).toBe(5);
    expect(plan.segments.map((s) => s.month)).toEqual(['2019-03', '2019-04']);
    expect(plan.segments[0].key).toBe(`2019-03:${plan.segments[0].lines[0].messageIds[0]}`);
    expect(plan.segments[0].lines.flatMap((l) => l.messageIds)).toContain(job);
    // April opens with the end of March as context.
    expect(plan.segments[1].leadIn.length).toBeGreaterThan(0);
    expect(planBootstrap(archive, memory).segments.map((s) => s.key)).toEqual(plan.segments.map((s) => s.key));
  });

  it('splits a month bigger than the segment size at its quiet gaps, and honors from/to', () => {
    for (let day = 0; day < 20; day++) {
      for (let i = 0; i < 20; i++) {
        say(MARCH + day * DAY + i * MIN, i % 2 ? REMI : DALE, i % 2 ? 'Remi' : 'Dale', `message ${day}-${i} ${'x'.repeat(60)}`);
      }
    }
    say(APRIL, NOVA, 'Nova', 'april');
    const plan = planBootstrap(archive, memory, { segmentTokens: 2_000 });
    const march = plan.segments.filter((s) => s.month === '2019-03');
    expect(march.length).toBeGreaterThan(3);
    // Each boundary falls on a day change (the longest quiet gaps).
    for (const segment of march.slice(1)) expect(segment.lines[0].timed).toBe(true);
    expect(planBootstrap(archive, memory, { from: '2019-04' }).segments.map((s) => s.month)).toEqual(['2019-04']);
    expect(planBootstrap(archive, memory, { to: '2019-03' }).segments.every((s) => s.month === '2019-03')).toBe(true);
  });
});

describe('estimateBootstrap', () => {
  it('prices the remaining segments and the dream from the catalog', () => {
    seedHistory();
    const plan = planBootstrap(archive, memory);
    const pricing = { promptUsdPerToken: 0.000004, completionUsdPerToken: 0.00002 };
    const estimate = estimateBootstrap(plan, { model: MODEL, pricing, dreamModel: MODEL, dreamPricing: pricing });
    expect(estimate).toMatchObject({ months: 2, messages: 5, segments: 2, remaining: 2 });
    expect(estimate.inputTokens).toBeGreaterThan(10_000);
    expect(estimate.costUsd).toBeCloseTo(
      estimate.inputTokens * 0.000004 + estimate.outputTokens * 0.00002,
      10,
    );
    expect(estimate.dream.people).toBe(3);
    expect(estimate.dream.costUsd).toBeGreaterThan(0);

    const later = estimateBootstrap(plan, { model: MODEL, dreamModel: MODEL, done: new Set([plan.segments[0].key]) });
    expect(later.remaining).toBe(1);
    expect(later.costUsd).toBeUndefined();
  });
});

describe('parseBootstrapAnswer', () => {
  function segment(): { segment: BootstrapSegment; plan: ReturnType<typeof planBootstrap>; job: string } {
    const job = seedHistory();
    const plan = planBootstrap(archive, memory);
    return { segment: plan.segments[0], plan, job };
  }

  it('keeps well-formed observations about known people, citing the quoted messages', () => {
    const { segment: s, plan, job } = segment();
    const { observations, dropped } = accepted(parseBootstrapAnswer(
      JSON.stringify({
        observations: [
          {
            category: 'Fact',
            subject_user_id: REMI_ALT,
            related_user_ids: [DALE, REMI, 'garbage'],
            content: 'Works early shifts at a bakery (since 2019-03).',
            date: '2019-03-01',
            quote: 'Remi: the bakery shift starts at 5am',
          },
          { category: 'vibe', content: 'The group roasts anyone who complains about work.', date: '2019-03' },
        ],
      }),
      s,
      plan.people,
    ));
    expect(dropped).toBe(0);
    expect(observations[0]).toEqual({
      category: 'fact',
      subjectUserId: REMI,
      relatedUserIds: [DALE],
      content: 'Works early shifts at a bakery (since 2019-03).',
      observedAt: MARCH + MIN,
      evidence: { messageIds: [job], quote: 'Remi: the bakery shift starts at 5am' },
    });
    expect(observations[1]).toMatchObject({ category: 'vibe', relatedUserIds: [] });
    expect(observations[1].subjectUserId).toBeUndefined();
    expect(observations[1].observedAt).toBe(Date.UTC(2019, 2, 15, 12));
  });

  it("matches quotes and related members the way capture does (src/ai/capture)", () => {
    const { segment: s, plan, job } = segment();
    const { observations } = accepted(parseBootstrapAnswer(
      JSON.stringify({
        observations: [
          // Typographic quote marks and an elision still find the line; a related member by name.
          {
            category: 'fact',
            subject_user_id: REMI,
            related_user_ids: ['Nova', 'nobody'],
            content: 'Works early shifts at a bakery.',
            quote: '“the bakery shift … 5am”',
          },
          // A quote from nowhere in this stretch is dropped, with its date kept.
          { category: 'fact', subject_user_id: DALE, content: 'Asks about work.', date: '2019-03-01', quote: 'made up' },
        ],
      }),
      s,
      plan.people,
    ));
    expect(observations[0]).toMatchObject({
      relatedUserIds: [NOVA],
      observedAt: MARCH + MIN,
      evidence: { messageIds: [job], quote: '“the bakery shift … 5am”' },
    });
    expect(observations[1].evidence).toBeUndefined();
    expect(observations[1].observedAt).toBe(Date.UTC(2019, 2, 1, 12));
  });

  it('drops what it cannot trust', () => {
    const { segment: s, plan } = segment();
    const { observations, dropped } = accepted(parseBootstrapAnswer(
      `Sure! \`\`\`json\n${JSON.stringify({
        observations: [
          { category: 'image', subject_user_id: REMI, content: 'Shared a meme.' },
          { category: 'fact', subject_user_id: '100000000000000999', content: 'Somebody unknown.' },
          { category: 'fact', content: 'A fact about nobody.' },
          { category: 'fact', subject_user_id: REMI, content: `Loves <:bread:900000000000000123>` },
          { category: 'fact', subject_user_id: REMI, content: 'x'.repeat(201) },
          { category: 'fact', subject_user_id: REMI, content: '   ' },
          null,
          { category: 'preference', subject_user_id: DALE, content: 'Likes teasing Remi.' },
        ],
      })}\n\`\`\``,
      s,
      plan.people,
    ));
    expect(observations.map((o) => o.content)).toEqual(['Likes teasing Remi.']);
    expect(observations[0].observedAt).toBe(MARCH);
    expect(dropped).toBe(7);
  });

  it('refuses an answer that is not the JSON object asked for, instead of reading it as "nothing to save"', () => {
    const { segment: s, plan } = segment();
    expect(parseBootstrapAnswer('not json', s, plan.people)).toEqual({ ok: false, error: 'the answer is not a JSON object' });
    expect(parseBootstrapAnswer("I can't help with reading private chats.", s, plan.people)).toMatchObject({ ok: false });
    // Cut off mid-list: the slice from the first { to the last } is not JSON either.
    const cut = '{"observations": [{"category": "fact", "content": "A."}, {"category": "fa';
    expect(parseBootstrapAnswer(cut, s, plan.people)).toEqual({ ok: false, error: 'the answer is not a JSON object' });
    expect(parseBootstrapAnswer('{"rows": []}', s, plan.people)).toEqual({
      ok: false,
      error: 'the answer has no "observations" list',
    });
    expect(parseBootstrapAnswer('{"observations": []}', s, plan.people)).toEqual({ ok: true, observations: [], dropped: 0 });
  });
});

describe('buildBootstrapPrompt', () => {
  it('keeps the capture rules and adds the history ones', () => {
    const prompt = buildBootstrapPrompt({ month: '2019-03', people: '- Remi (id:1)', known: '(nothing yet)', transcript: 'T' });
    expect(prompt).toContain('record what a message REVEALS, never what it DID');
    expect(prompt).toContain('no softening, no censoring');
    expect(prompt).toContain('emit it again with the SAME content');
    expect(prompt).toContain('never extract from them');
    expect(prompt.endsWith('T')).toBe(true);
  });
});

describe('runBootstrap', () => {
  it('reads every segment in order, journals what it learns, and dreams at the end', async () => {
    const job = seedHistory();
    const { client, requests } = createCapturingClient([
      answer([
        {
          category: 'fact',
          subject_user_id: REMI,
          related_user_ids: [],
          content: 'Works early shifts at a bakery.',
          date: '2019-03-01',
          quote: 'the bakery shift starts at 5am',
        },
      ]),
      answer([
        {
          category: 'fact',
          subject_user_id: REMI,
          content: 'Works early shifts at a bakery.',
          date: '2019-04-01',
          quote: 'bakery again at 5am lol',
        },
      ]),
    ]);
    const dream = vi.fn(async (): Promise<NightlyDreamResult> => ({ day: '2026-09-26', people: [] }));
    const lines: string[] = [];

    const result = await runBootstrap({
      archive,
      memory,
      notes,
      client,
      model: MODEL,
      dream,
      log: (line) => lines.push(line),
      now: () => new Date('2026-09-26T12:00:00Z'),
    });

    expect(result).toMatchObject({ segmentsDone: 2, segmentsFailed: 0, segmentsLeft: 0, rows: 2, dropped: 0 });
    expect(result.costUsd).toBeCloseTo(0.025);
    for (const request of requests) {
      expect(request.body.model).toBe(MODEL);
      expect(request.body.provider).toEqual({ zdr: true });
      expect(request.headers.get(FEATURE_HEADER)).toBe('memory_bootstrap');
    }
    // The second segment sees what the first one learned, and the same fact merges as a recurrence.
    const secondPrompt = (requests[1].body.messages as { content: string }[])[0].content;
    expect(secondPrompt).toContain('- [fact] Remi: Works early shifts at a bakery. (2019-03)');
    expect(secondPrompt).toContain('## ALREADY COVERED');
    const rows = memory.getForPerson({ userId: REMI, names: ['Remi'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'bootstrap', seen_count: 2, subject: 'Remi' });
    expect(rows[0].first_seen_at).toBe('2019-03-02 00:01:00');
    expect(rows[0].last_seen_at).toBe('2019-04-02 00:00:00');
    expect(JSON.parse(rows[0].evidence ?? '{}').messageIds[0]).toBe(job);

    expect(dream).toHaveBeenCalledTimes(1);
    expect(readProgress(memory)).toMatchObject({ model: MODEL, rows: 2 });
    expect(lines.at(-1)).toContain('dreaming 1 people');
  });

  it("gives each call the dream's long timeout, not the shared client's 2-minute default", async () => {
    seedHistory();
    const { client } = createCapturingClient([answer([]), answer([])]);
    const create = vi.spyOn(client.chat.completions, 'create');
    await runBootstrap({ archive, memory, notes, client, model: MODEL, log: () => {} });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][1]).toMatchObject({ timeout: 600_000, maxRetries: 1 });
  });

  it('reads only the months asked for, and leaves the dream to a run over the whole archive', async () => {
    seedHistory();
    const { client, requests } = createCapturingClient([answer([])]);
    const dream = vi.fn(async (): Promise<NightlyDreamResult> => ({ day: '2026-09-26', people: [] }));
    const run = await runBootstrap({ archive, memory, notes, client, model: MODEL, from: '2019-03', to: '2019-03', dream, log: () => {} });
    expect(requests).toHaveLength(1);
    expect((requests[0].body.messages as { content: string }[])[0].content).toContain('(2019-03)');
    expect(run.segmentsLeft).toBe(0);
    expect(dream).not.toHaveBeenCalled();
  });

  it('resumes after the last finished segment, and leaves a failed one for the next run', async () => {
    seedHistory();
    const first = createCapturingClient([answer([]), { error: new Error('socket hang up') }]);
    const dream = vi.fn(async (): Promise<NightlyDreamResult> => ({ day: '2026-09-26', people: [] }));
    const run1 = await runBootstrap({ archive, memory, notes, client: first.client, model: MODEL, dream, log: () => {} });
    expect(run1).toMatchObject({ segmentsDone: 1, segmentsFailed: 1, segmentsLeft: 1 });
    expect(dream).not.toHaveBeenCalled();
    expect(JSON.parse(memory.getState(BOOTSTRAP_PROGRESS_KEY) ?? '{}').done).toHaveLength(1);

    const second = createCapturingClient([answer([])]);
    const run2 = await runBootstrap({ archive, memory, notes, client: second.client, model: MODEL, dream, log: () => {} });
    expect(second.requests).toHaveLength(1);
    expect((second.requests[0].body.messages as { content: string }[])[0].content).toContain('(2019-04)');
    expect(run2).toMatchObject({ segmentsDone: 1, segmentsLeft: 0 });
    expect(dream).toHaveBeenCalledTimes(1);
  });

  it('keeps the segment size the run started with, so a resumed run never reads a stretch twice', async () => {
    for (let day = 0; day < 20; day++) {
      for (let i = 0; i < 20; i++) {
        say(MARCH + day * DAY + i * MIN, i % 2 ? REMI : DALE, i % 2 ? 'Remi' : 'Dale', `message ${day}-${i} ${'x'.repeat(60)}`);
      }
    }
    const small = planBootstrap(archive, memory, { segmentTokens: 2_000 });
    expect(small.segments.length).toBeGreaterThan(3);

    // A trial with small segments…
    const trial = createCapturingClient([answer([])]);
    await runBootstrap({ archive, memory, notes, client: trial.client, model: MODEL, segmentTokens: 2_000, maxSegments: 1, log: () => {} });
    expect(readProgress(memory)?.segmentTokens).toBe(2_000);

    // …then the rest without the flag: the same cut, so exactly the other segments.
    const rest = createCapturingClient(small.segments.slice(1).map(() => answer([])));
    const run = await runBootstrap({ archive, memory, notes, client: rest.client, model: MODEL, log: () => {} });
    expect(run).toMatchObject({ segmentsDone: small.segments.length - 1, segmentsLeft: 0 });
    expect(rest.requests).toHaveLength(small.segments.length - 1);
    expect(readProgress(memory)?.done).toEqual(small.segments.map((s) => s.key));

    // Another size would cut the month anew and read it again: refused.
    await expect(
      runBootstrap({ archive, memory, notes, client: rest.client, model: MODEL, segmentTokens: 60_000, log: () => {} }),
    ).rejects.toThrow('segments of 2000 tokens');
  });

  it('stops after maxSegments for a trial run, and reports a dream failure without throwing', async () => {
    seedHistory();
    const trial = createCapturingClient([answer([])]);
    const run = await runBootstrap({ archive, memory, notes, client: trial.client, model: MODEL, maxSegments: 1, log: () => {} });
    expect(run).toMatchObject({ segmentsDone: 1, segmentsLeft: 1 });

    const rest = createCapturingClient([answer([])]);
    const dream = vi.fn(async (): Promise<NightlyDreamResult> => {
      throw new Error('the dream model is down');
    });
    const finished = await runBootstrap({ archive, memory, notes, client: rest.client, model: MODEL, dream, log: () => {} });
    expect(finished.dream).toEqual({ error: 'the dream model is down' });
  });

  it('treats an empty answer as a failure', async () => {
    seedHistory();
    const { client } = createCapturingClient([{ body: chatCompletionBody('') }, answer([])]);
    const run = await runBootstrap({ archive, memory, notes, client, model: MODEL, log: () => {} });
    expect(run).toMatchObject({ segmentsDone: 1, segmentsFailed: 1 });
  });

  it('fails a segment whose answer is unusable, keeps it out of the progress, and reads it again next run', async () => {
    seedHistory();
    const plan = planBootstrap(archive, memory);
    const lines: string[] = [];
    const refusal: ScriptedReply = {
      body: { ...(chatCompletionBody("Sorry, I can't go through private chat logs.") as object), usage: { cost: 0.01 } },
    };
    const first = createCapturingClient([refusal, answer([])]);
    const run1 = await runBootstrap({ archive, memory, notes, client: first.client, model: MODEL, log: (l) => lines.push(l) });
    expect(run1).toMatchObject({ segmentsDone: 1, segmentsFailed: 1, segmentsLeft: 1, rows: 0 });
    // Its cost still counts.
    expect(run1.costUsd).toBeCloseTo(0.0225);
    expect(readProgress(memory)?.done).toEqual([plan.segments[1].key]);
    expect(readProgress(memory)?.costUsd).toBeCloseTo(0.0225);
    expect(lines.find((l) => l.includes('FAILED'))).toContain('the answer is not a JSON object');

    const second = createCapturingClient([answer([])]);
    const run2 = await runBootstrap({ archive, memory, notes, client: second.client, model: MODEL, log: () => {} });
    expect(run2).toMatchObject({ segmentsDone: 1, segmentsLeft: 0 });
    expect(promptOf(second.requests[0])).toContain('(2019-03)');
  });

  it('reads a segment whose answer was cut off again in two halves, and journals it once both are read', async () => {
    const job = seedHistory();
    const plan = planBootstrap(archive, memory);
    const march = plan.segments[0];
    const halves = splitSegment(march);
    expect(halves).toBeDefined();
    const [firstHalf, secondHalf] = halves ?? [march, march];
    expect([...firstHalf.lines, ...secondHalf.lines]).toEqual(march.lines);
    // The first line (with its day header) is already half of this small month.
    expect(firstHalf.lines.map((l) => l.author)).toEqual(['Dale']);
    expect(secondHalf.lines.map((l) => l.author)).toEqual(['Remi', 'Nova']);
    expect(secondHalf.leadIn).toEqual(firstHalf.lines);
    const lines: string[] = [];
    const { client, requests } = createCapturingClient([
      cutOff(),
      answer([]),
      answer([
        { category: 'fact', subject_user_id: REMI, content: 'Works early shifts at a bakery.', quote: 'the bakery shift starts at 5am' },
        { category: 'personality', subject_user_id: NOVA, content: 'Answers bad news with "rip".' },
      ]),
      answer([]),
    ]);

    const run = await runBootstrap({ archive, memory, notes, client, model: MODEL, log: (l) => lines.push(l) });

    expect(run).toMatchObject({ segmentsDone: 2, segmentsFailed: 0, segmentsLeft: 0, rows: 2 });
    expect(run.costUsd).toBeCloseTo(0.2 + 3 * 0.0125);
    expect(requests).toHaveLength(4);
    // Each half is its own transcript: the second opens with the end of the first as context.
    const [whole, one, two] = requests.map(promptOf);
    expect(whole).toContain('the bakery shift starts at 5am');
    expect(one).toContain('how was the first week');
    expect(one).not.toContain('the bakery shift');
    expect(one).not.toContain('## ALREADY COVERED');
    expect(two.split('## NEW')[0]).toContain('## ALREADY COVERED');
    expect(two.split('## NEW')[0]).toContain('how was the first week');
    expect(two.split('## NEW')[1]).toContain('the bakery shift starts at 5am');
    const rows = memory.getForPerson({ userId: REMI, names: ['Remi'] });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].evidence ?? '{}').messageIds).toEqual([job]);
    expect(memory.getForPerson({ userId: NOVA, names: ['Nova'] })).toHaveLength(1);
    expect(readProgress(memory)?.done).toEqual(plan.segments.map((s) => s.key));
    expect(lines.find((l) => l.startsWith('2019-03'))).toContain('read in 2 parts');
  });

  it('fails a cut-off segment it cannot split, and writes nothing of it', async () => {
    say(MARCH, REMI, 'Remi', 'the bakery shift starts at 5am');
    const plan = planBootstrap(archive, memory);
    expect(plan.segments[0].lines).toHaveLength(1);
    expect(splitSegment(plan.segments[0])).toBeUndefined();
    const lines: string[] = [];
    const { client, requests } = createCapturingClient([cutOff()]);
    const run = await runBootstrap({ archive, memory, notes, client, model: MODEL, log: (l) => lines.push(l) });
    expect(requests).toHaveLength(1);
    expect(run).toMatchObject({ segmentsDone: 0, segmentsFailed: 1, segmentsLeft: 1, rows: 0 });
    expect(run.costUsd).toBeCloseTo(0.2);
    expect(memory.getForPerson({ userId: REMI, names: ['Remi'] })).toHaveLength(0);
    expect(readProgress(memory)?.done).toEqual([]);
    expect(lines.at(-1)).toContain('FAILED, left for the next run: the answer was cut off at the length limit');
  });

  it('writes nothing of a split segment when one of its halves fails', async () => {
    seedHistory();
    const plan = planBootstrap(archive, memory);
    const { client, requests } = createCapturingClient([
      cutOff(),
      answer([{ category: 'fact', subject_user_id: REMI, content: 'Works early shifts at a bakery.' }]),
      // The second half's call, and its one retry.
      { error: new Error('socket hang up') },
      { error: new Error('socket hang up') },
    ]);
    const run = await runBootstrap({ archive, memory, notes, client, model: MODEL, maxSegments: 1, log: () => {} });
    expect(requests).toHaveLength(4);
    expect(run).toMatchObject({ segmentsDone: 0, segmentsFailed: 1, rows: 0 });
    expect(run.costUsd).toBeCloseTo(0.2125);
    expect(memory.getForPerson({ userId: REMI, names: ['Remi'] })).toHaveLength(0);
    expect(readProgress(memory)?.done ?? []).not.toContain(plan.segments[0].key);
  });
});
