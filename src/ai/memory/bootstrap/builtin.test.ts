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
  readProgress,
  runBootstrap,
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
    const { observations, dropped } = parseBootstrapAnswer(
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
    );
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

  it('drops what it cannot trust', () => {
    const { segment: s, plan } = segment();
    const { observations, dropped } = parseBootstrapAnswer(
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
    );
    expect(observations.map((o) => o.content)).toEqual(['Likes teasing Remi.']);
    expect(observations[0].observedAt).toBe(MARCH);
    expect(dropped).toBe(7);
    expect(parseBootstrapAnswer('not json', s, plan.people)).toEqual({ observations: [], dropped: 0 });
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
});
