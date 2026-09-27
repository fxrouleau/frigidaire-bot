import { ChannelType } from 'discord.js';
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveStore, setArchiveStoreForTesting } from '../../../archive/archiveStore';
import { config } from '../../../config';
import {
  type CapturedRequest,
  chatCompletionBody,
  createCapturingClient,
  type ScriptedReply,
} from '../../../test-support/capturingClient';
import { archiveInput, GUILD_ID, snowflake } from '../../../test-support/fakeArchive';
import { CORRECTION_CATEGORY, MemoryStore } from '../memoryStore';
import {
  applyEdit,
  type DreamDeps,
  dreamGroup,
  dreamPerson,
  dryRunEdit,
  type EditProposal,
  GROUP_REFRESH_DAYS,
  planGroupDream,
  previewChanges,
  proposeEdit,
  runDreamsUntilCaughtUp,
  runNightlyDream,
  summarizePersonChanges,
} from './dreamer';
import { DREAM_LEASE_KEY, takeDreamLease } from './dreamLease';
import { MAX_JOURNAL_ROWS_PER_DREAM } from './dreamPrompts';
import { type NoteChange, NotesStore } from './notesStore';
import type { EvidencePassage } from './passages';
import { NOTE_LIMITS, validateNotesOutput } from './schema';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const REMI_ALT = '100000000000000011';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const remi = { scope: 'person', ownerId: REMI } as const;
const dale = { scope: 'person', ownerId: DALE } as const;
const group = { scope: 'group' } as const;
const NOW = new Date('2026-09-26T08:30:00Z'); // 04:30 Eastern

let memory: MemoryStore;
let notes: NotesStore;

beforeEach(() => {
  memory = new MemoryStore(':memory:');
  memory.upsertIdentity(REMI, 'Remi', 'remi_bakes');
  memory.upsertIdentity(DALE, 'Dale');
  memory.upsertIdentity(NOVA, 'Nova');
  notes = new NotesStore(memory, { now: () => NOW });
  notes.writeNotes(
    remi,
    [
      { topic: 'profile', title: 'Remi', content: '## Now\nNight shifts.' },
      { topic: 'games', title: 'Games', content: 'Valorant.' },
    ],
    {
      updatedBy: 'dream',
      circles: [{ slug: 'mtg', title: 'The MTG crew', content: 'Drafts.', members: [{ id: REMI }, { id: DALE }] }],
    },
  );
  notes.writeCircles(
    [{ slug: 'magic', title: 'Magic nights', content: 'Same crew.', members: [{ id: REMI }, { id: DALE }] }],
    { updatedBy: 'dream' },
  );
});

afterEach(() => {
  memory.close();
  vi.unstubAllEnvs();
});

function output(raw: unknown) {
  const result = validateNotesOutput(raw, { scope: 'person' });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.value;
}

/** A scripted chat completion whose answer is `answer` (JSON-encoded unless a string), with its usage cost. */
function reply(answer: unknown, opts: { cost?: number; finish?: string } = {}): ScriptedReply {
  const body = chatCompletionBody(
    typeof answer === 'string' ? answer : JSON.stringify(answer),
    'anthropic/claude-opus-5.5',
  ) as {
    choices: { finish_reason: string }[];
    usage?: unknown;
  };
  if (opts.finish) body.choices[0].finish_reason = opts.finish;
  body.usage = { prompt_tokens: 3000, completion_tokens: 900, cost: opts.cost ?? 0.03 };
  return { body };
}

function messagesOf(request: CapturedRequest): { role: string; content: string }[] {
  return request.body.messages as { role: string; content: string }[];
}

function userPrompt(request: CapturedRequest): string {
  return messagesOf(request)[1].content;
}

function deps(client: DreamDeps['client'], extra: Partial<DreamDeps> = {}): DreamDeps {
  return { notes, memory, client, now: () => NOW, loadPassages: () => [], ...extra };
}

const newProfile = (content = '## Now\nDay shifts at the bakery (since 2026-08).\n\n## Earlier\n- Night shifts until 2026-08.') => ({
  topic: 'profile',
  title: 'Remi',
  content,
});

async function saveFact(content: string, extra: Partial<Parameters<MemoryStore['save']>[0]> = {}): Promise<number> {
  return memory.save({ category: 'fact', subject: 'Remi', subject_user_id: REMI, content, source: 'observation', ...extra });
}

describe('previewChanges', () => {
  it('lists changed, added and removed notes and circles, leaving identical drafts out', () => {
    const proposed = output({
      notes: [
        { topic: 'profile', title: 'Remi', content: '## Now\nDay shifts now.' },
        { topic: 'work', title: 'Work', content: 'Bakery.' },
      ],
      removed_topics: ['games'],
      circles: [
        {
          slug: 'mtg',
          title: 'The MTG crew',
          content: 'Drafts.',
          members: [{ id: REMI }, { id: DALE, until: '2026-09' }],
          merged_from: ['magic'],
        },
      ],
      change_summary: 'day shifts',
    });
    const changes = previewChanges(notes, remi, proposed);
    expect(changes.map((c) => [c.kind, c.key, c.change])).toEqual([
      ['note', 'profile', 'changed'],
      ['note', 'work', 'added'],
      ['note', 'games', 'removed'],
      ['circle', 'mtg', 'changed'],
      ['circle', 'magic', 'removed'],
    ]);
    expect(changes[0]).toMatchObject({ before: '## Now\nNight shifts.', after: '## Now\nDay shifts now.' });
    expect(changes[3].membersAfter?.find((m) => m.memberId === DALE)?.until).toBe('2026-09');

    const same = output({ notes: [{ topic: 'games', title: 'Games', content: 'Valorant.' }], change_summary: '' });
    expect(previewChanges(notes, remi, same)).toEqual([]);
  });
});

describe('applyEdit', () => {
  it('saves a confirmed proposal as edit versions with the instruction as the reason', () => {
    const proposal: Extract<EditProposal, { ok: true }> = {
      ok: true,
      target: remi,
      output: output({ notes: [{ topic: 'profile', title: 'Remi', content: '## Now\nDay shifts.' }], change_summary: 'x' }),
      allowedIds: [],
      changeSummary: 'x',
    };
    const result = applyEdit(proposal, 'he works days now', notes);
    expect(result.ok).toBe(true);
    const profile = notes.getProfile(REMI);
    expect([profile?.updatedBy, notes.getVersion(profile?.id ?? 0, 2)?.reason]).toEqual(['edit', 'he works days now']);
  });
});

describe('dreamPerson', () => {
  it('skips a person with nothing above their watermark, without a model call', async () => {
    const { client, requests } = createCapturingClient([]);
    expect(await dreamPerson(REMI, deps(client))).toEqual({ status: 'skipped', owner: remi, reason: 'nothing-new' });
    expect(requests).toHaveLength(0);
  });

  it('makes one ZDR call tagged memory_dream with the rules and the whole input, saves dream versions and moves the watermark', async () => {
    await saveFact('Works day shifts at the bakery now.', {
      evidence: { messageIds: ['1300000000000000001'], quote: 'finally on days' },
    });
    await memory.save({
      category: CORRECTION_CATEGORY,
      subject: 'Remi',
      subject_user_id: REMI,
      said_by: REMI,
      content: 'Quit Valorant in August 2026.',
      source: 'correction',
    });
    await memory.save({
      category: 'fact',
      subject: 'Dale',
      subject_user_id: DALE,
      content: 'Dale and Remi have been best friends since school.',
      source: 'observation',
      related_user_ids: [REMI],
    });
    await memory.save({ category: 'fact', subject: 'Nova', subject_user_id: NOVA, content: 'Nova plays chess.' });
    const high = notes.journalHighWater();

    const { client, requests } = createCapturingClient([
      reply(
        {
          notes: [newProfile()],
          removed_topics: ['games'],
          circles: [
            {
              slug: 'remi-dale',
              title: 'Remi & Dale',
              content: '## Now\nBest friends since school.',
              members: [{ id: REMI }, { id: DALE }],
            },
          ],
          change_summary: 'day shifts; quit Valorant',
        },
        { cost: 0.042 },
      ),
    ]);
    const outcome = await dreamPerson(REMI, deps(client));

    expect(outcome).toMatchObject({ status: 'updated', changeSummary: 'day shifts; quit Valorant', costUsd: 0.042 });
    if (outcome.status !== 'updated') throw new Error('not updated');
    expect(outcome.written.map((n) => n.topic).sort()).toEqual(['profile', 'remi-dale']);
    expect(outcome.removed.map((n) => n.topic)).toEqual(['games']);
    // Nova's row is newer but not Remi's: the watermark is the highest row the dream read.
    expect(outcome.watermark).toBe(high - 1);
    expect(notes.getDreamState(remi)).toMatchObject({ journalWatermark: high - 1, lastError: null });
    const profile = notes.getProfile(REMI);
    expect(profile).toMatchObject({ version: 2, updatedBy: 'dream' });
    expect(notes.getVersion(profile?.id ?? 0, 2)?.reason).toBe('day shifts; quit Valorant');
    expect(notes.getCircle('remi-dale')?.members.map((m) => m.memberId)).toEqual([REMI, DALE]);

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toMatch(/\/chat\/completions$/);
    expect(request.headers.get('X-Frigidaire-Feature')).toBe('memory_dream');
    expect(request.body).toMatchObject({ model: config.dream.model, max_tokens: 16_000, provider: { zdr: true } });
    expect(request.body.reasoning).toBeUndefined();
    const [system, user] = messagesOf(request);
    expect(system.role).toBe('system');
    expect(system.content).toContain('A correction a person made about themself beats everything else');
    expect(system.content).toContain('Recency × recurrence decide weight');
    expect(system.content).toContain("Don't censor, soften or paraphrase away");
    expect(user.role).toBe('user');
    expect(user.content).toContain('TODAY: Saturday, September 26, 2026 (2026-09-26, Eastern time)');
    expect(user.content).toContain(`- Remi @remi_bakes (id:${REMI})`);
    expect(user.content).toContain(`- Dale (id:${DALE})`);
    expect(user.content).toContain('<note topic="profile" title="Remi" version="1"');
    expect(user.content).toContain('<circle slug="mtg" title="The MTG crew"');
    expect(user.content).toContain(`  - Dale (id:${DALE}; current)`);
    expect(user.content).toContain('[fact]');
    expect(user.content).toContain('picked up in chat: Works day shifts at the bakery now. Quote: "finally on days"');
    expect(user.content).toContain('[CORRECTION by Remi about themself: authoritative]');
    expect(user.content).toContain('Dale and Remi have been best friends since school. Filed under Dale.');
    expect(user.content).not.toContain('Nova plays chess');

    // Everything read is folded in: the next dream has nothing to do.
    expect(await dreamPerson(REMI, deps(client))).toMatchObject({ status: 'skipped' });
    expect(requests).toHaveLength(1);
  });

  it("dreams a side account's main account", async () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${REMI_ALT}:${REMI}`);
    await saveFact('Bakes sourdough on Sundays.');
    const { client } = createCapturingClient([reply({ notes: [newProfile()], change_summary: 'sourdough' })]);
    expect(await dreamPerson(REMI_ALT, deps(client))).toMatchObject({ status: 'updated', owner: remi });
  });

  it('asks once more with the errors when the answer is refused, and saves the fixed one', async () => {
    await saveFact('Works day shifts at the bakery now.');
    const { client, requests } = createCapturingClient([
      reply({ notes: [newProfile('x'.repeat(NOTE_LIMITS.profileMaxChars + 1))], change_summary: 'too long' }, { cost: 0.02 }),
      reply({ notes: [newProfile()], change_summary: 'day shifts' }, { cost: 0.03 }),
    ]);
    const outcome = await dreamPerson(REMI, deps(client));
    expect(outcome).toMatchObject({ status: 'updated', changeSummary: 'day shifts' });
    expect(outcome.status === 'updated' ? outcome.costUsd : undefined).toBeCloseTo(0.05);

    expect(requests).toHaveLength(2);
    const repair = messagesOf(requests[1]);
    expect(repair.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(repair[3].content).toContain('Your answer could not be saved');
    expect(repair[3].content).toContain(`over the ${NOTE_LIMITS.profileMaxChars} limit`);
  });

  it('feeds a write the store refuses back as errors (a circle the person is not in)', async () => {
    await saveFact('Dale and Nova started a book club.');
    const { client, requests } = createCapturingClient([
      reply({
        notes: [newProfile()],
        circles: [{ slug: 'book-club', title: 'Book club', content: 'Books.', members: [{ id: DALE }, { id: NOVA }] }],
        change_summary: 'book club',
      }),
      reply({ notes: [newProfile()], change_summary: 'day shifts' }),
    ]);
    expect(await dreamPerson(REMI, deps(client))).toMatchObject({ status: 'updated' });
    expect(messagesOf(requests[1])[3].content).toContain("a person's notes only change circles they are part of");
    expect(notes.getCircle('book-club')).toBeUndefined();
  });

  it('asks for a shorter answer after one cut off at the length limit', async () => {
    await saveFact('Works day shifts at the bakery now.');
    const { client, requests } = createCapturingClient([
      reply('{"notes": [{"topic": "profile", "title": "Remi", "content": "## Now\\nDay', { finish: 'length' }),
      reply({ notes: [newProfile()], change_summary: 'day shifts' }),
    ]);
    expect(await dreamPerson(REMI, deps(client))).toMatchObject({ status: 'updated' });
    const repair = messagesOf(requests[1]);
    expect(repair[2].content).toBe('(an answer cut off at the length limit)');
    expect(repair[3].content).toContain('cut off at the length limit');
  });

  it('fails without moving the watermark or touching the notes when the repair is refused too', async () => {
    await saveFact('Works day shifts at the bakery now.');
    const { client, requests } = createCapturingClient([
      reply('no json here'),
      reply({ notes: [{ topic: 'games', title: 'Games', content: 'Deadlock.' }], change_summary: 'x' }),
    ]);
    const outcome = await dreamPerson(REMI, deps(client));
    expect(outcome).toMatchObject({ status: 'failed', owner: remi });
    expect(outcome.status === 'failed' ? outcome.error : '').toContain('must include the "profile" topic');
    expect(requests).toHaveLength(2);
    expect(notes.getDreamState(remi)).toMatchObject({ journalWatermark: 0 });
    expect(notes.getDreamState(remi).lastError).toContain('profile');
    expect(notes.getProfile(REMI)?.version).toBe(1);
    expect(notes.newJournal(remi)).toHaveLength(1);
  });

  it('turns a model error into a recorded failure, never a throw', async () => {
    await saveFact('Works day shifts at the bakery now.');
    const { client } = createCapturingClient([{ status: 400, body: { error: { message: 'model not found' } } }]);
    const outcome = await dreamPerson(REMI, deps(client));
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(outcome.status === 'failed' ? outcome.error : '').toMatch(/^400 /);
    expect(notes.getDreamState(remi).lastError).toMatch(/^400 /);
  });

  it('fails cleanly without an OpenRouter key', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    await saveFact('Works day shifts at the bakery now.');
    const outcome = await dreamPerson(REMI, { notes, memory, now: () => NOW });
    expect(outcome).toMatchObject({ status: 'failed', error: 'OPENROUTER_API_KEY is not set' });
  });

  it('reports unchanged (and still moves the watermark) when the answer repeats the notes', async () => {
    await saveFact('Works nights.');
    const { client } = createCapturingClient([
      reply({ notes: [{ topic: 'profile', title: 'Remi', content: '## Now\nNight shifts.' }], change_summary: '' }),
    ]);
    const outcome = await dreamPerson(REMI, deps(client));
    expect(outcome).toMatchObject({ status: 'unchanged', watermark: notes.journalHighWater() });
    expect(notes.getProfile(REMI)?.version).toBe(1);
    expect(notes.newJournal(remi)).toEqual([]);
  });

  it('labels a third-party claim as one to weigh', async () => {
    await memory.save({
      category: CORRECTION_CATEGORY,
      subject: 'Remi',
      subject_user_id: REMI,
      said_by: DALE,
      content: 'Moved to Laval.',
      source: 'correction',
    });
    const { client, requests } = createCapturingClient([reply({ notes: [newProfile()], change_summary: 'x' })]);
    await dreamPerson(REMI, deps(client));
    expect(userPrompt(requests[0])).toContain(
      '[CORRECTION claimed by Dale about Remi: a third-party claim, weigh it]',
    );
  });

  it('reads at most MAX_JOURNAL_ROWS_PER_DREAM rows, the oldest first, and leaves the rest for the next night', async () => {
    const insert = memory
      .sharedDatabase()
      .prepare("INSERT INTO memories (category, subject, content, source, subject_user_id) VALUES ('fact', 'Remi', ?, 'observation', ?)");
    for (let i = 0; i < MAX_JOURNAL_ROWS_PER_DREAM + 5; i++) insert.run(`Fact number ${i}.`, REMI);
    const rows = notes.newJournal(remi);
    const { client, requests } = createCapturingClient([reply({ notes: [newProfile()], change_summary: 'x' })]);
    const outcome = await dreamPerson(REMI, deps(client));
    expect(outcome).toMatchObject({ watermark: rows[MAX_JOURNAL_ROWS_PER_DREAM - 1].journal_seq });
    expect(userPrompt(requests[0])).toContain(`NEW JOURNAL (${MAX_JOURNAL_ROWS_PER_DREAM} entries, oldest first)`);
    expect(notes.newJournal(remi)).toHaveLength(5);
  });
});

describe('a write that lands while the model is thinking', () => {
  const ownerEdit = () => {
    const saved = notes.writeNotes(remi, [{ topic: 'profile', title: 'Remi', content: '## Now\nMoved to Laval.' }], {
      updatedBy: 'edit',
      reason: 'he moved',
    });
    if (!saved.ok) throw new Error(saved.errors.join('; '));
  };

  it("never overwrites an owner edit saved during the dream's call: failed, no repair, the watermark stays", async () => {
    await saveFact('Works day shifts at the bakery now.');
    const { client, requests } = createCapturingClient(
      [reply({ notes: [newProfile()], change_summary: 'day shifts' }), reply({ notes: [newProfile()], change_summary: 'x' })],
      { onRequest: ownerEdit },
    );
    const outcome = await dreamPerson(REMI, deps(client));
    expect(outcome).toMatchObject({ status: 'failed', owner: remi, costUsd: 0.03 });
    expect(outcome.status === 'failed' ? outcome.error : '').toContain('changed while dreaming (profile)');
    // No repair round: the model can't fix notes it never saw.
    expect(requests).toHaveLength(1);
    expect(notes.getProfile(REMI)).toMatchObject({ version: 2, updatedBy: 'edit', content: '## Now\nMoved to Laval.' });
    expect(notes.getDreamState(remi)).toMatchObject({ journalWatermark: 0 });
    expect(notes.getDreamState(remi).lastError).toContain('changed while dreaming');
    expect(notes.newJournal(remi)).toHaveLength(1);
  });

  it('refuses a circle that changed meanwhile, and saves when only circles it leaves alone did', async () => {
    await saveFact('Drafts on Fridays with Dale.');
    const editCircle = (slug: string, content: string) => () => {
      const saved = notes.writeCircles(
        [{ slug, title: slug === 'mtg' ? 'The MTG crew' : 'Magic nights', content, members: [{ id: REMI }, { id: DALE }] }],
        { updatedBy: 'edit' },
      );
      if (!saved.ok) throw new Error(saved.errors.join('; '));
    };
    const mtg = {
      slug: 'mtg',
      title: 'The MTG crew',
      content: '## Now\nFriday drafts.',
      members: [{ id: REMI }, { id: DALE }],
    };
    const touched = createCapturingClient([reply({ notes: [newProfile()], circles: [mtg], change_summary: 'fridays' })], {
      onRequest: editCircle('mtg', '## Now\nCommander now.'),
    });
    const refused = await dreamPerson(REMI, deps(touched.client));
    expect(refused.status === 'failed' ? refused.error : '').toContain('changed while dreaming (circle:mtg)');
    expect(notes.getCircle('mtg')?.content).toBe('## Now\nCommander now.');

    const untouched = createCapturingClient([reply({ notes: [newProfile()], circles: [mtg], change_summary: 'fridays' })], {
      onRequest: editCircle('magic', '## Now\nSame crew, other night.'),
    });
    expect(await dreamPerson(REMI, deps(untouched.client))).toMatchObject({ status: 'updated' });
    expect(notes.getCircle('mtg')?.content).toBe('## Now\nFriday drafts.');
    expect(notes.getCircle('magic')?.content).toBe('## Now\nSame crew, other night.');
  });

  it("never overwrites the group's notes changed during the group pass", async () => {
    notes.writeNotes(group, [{ topic: 'vibe', title: 'Vibe', content: '## Now\nChill.' }], { updatedBy: 'dream' });
    await memory.save({ category: 'vibe', subject: 'server', content: 'Roasts are affection here.' });
    const { client, requests } = createCapturingClient(
      [reply({ notes: [{ topic: 'vibe', title: 'Vibe', content: '## Now\nRoasts.' }], change_summary: 'roasts' })],
      {
        onRequest: () => {
          notes.writeNotes(group, [{ topic: 'lore', title: 'Lore', content: '## Now\nThe 2026 LAN.' }], {
            updatedBy: 'edit',
          });
        },
      },
    );
    const outcome = await dreamGroup(deps(client), { personChanges: [] });
    expect(outcome.status === 'failed' ? outcome.error : '').toContain('changed while dreaming (lore)');
    expect(requests).toHaveLength(1);
    expect(notes.getNote(group, 'vibe')?.content).toBe('## Now\nChill.');
    expect(notes.getNote(group, 'lore')?.content).toBe('## Now\nThe 2026 LAN.');
    expect(notes.newJournal(group)).toHaveLength(1);
  });

  it("refuses an owner edit drafted from notes a dream rewrote meanwhile (Confirm would undo the dream's work)", async () => {
    const { client, requests } = createCapturingClient(
      [reply({ notes: [{ topic: 'profile', title: 'Remi', content: '## Now\nDay shifts.' }], change_summary: 'x' })],
      {
        onRequest: () => {
          notes.writeNotes(remi, [newProfile('## Now\nNight shifts; new bakery job (2026-09).')], { updatedBy: 'dream' });
        },
      },
    );
    const proposal = await proposeEdit({ target: remi, instruction: 'he works days now', requestedBy: NOVA }, deps(client));
    expect(proposal).toMatchObject({ ok: false });
    expect(proposal.ok ? '' : proposal.error).toContain('changed while drafting (profile)');
    expect(requests).toHaveLength(1);
    expect(notes.getProfile(REMI)).toMatchObject({ version: 2, updatedBy: 'dream' });
  });
});

describe("a dream keeps every circle member (current and former)", () => {
  const withNova = () => {
    const saved = notes.writeCircles(
      [
        {
          slug: 'mtg',
          title: 'The MTG crew',
          content: '## Now\nDrafts.',
          members: [{ id: REMI }, { id: DALE }, { id: NOVA, since: '2021', until: '2023' }],
        },
      ],
      { updatedBy: 'dream' },
    );
    if (!saved.ok) throw new Error(saved.errors.join('; '));
  };
  const mtg = (members: { id: string; since?: string; until?: string }[]) => ({
    slug: 'mtg',
    title: 'The MTG crew',
    content: '## Now\nFriday drafts.',
    members,
  });

  it("refuses a rewrite that drops a former member, and saves the repaired one with them kept", async () => {
    withNova();
    await saveFact('Drafts on Fridays with Dale.');
    const { client, requests } = createCapturingClient([
      reply({ notes: [newProfile()], circles: [mtg([{ id: REMI }, { id: DALE }])], change_summary: 'fridays' }),
      reply({
        notes: [newProfile()],
        circles: [mtg([{ id: REMI }, { id: DALE }, { id: NOVA, since: '2021', until: '2023' }])],
        change_summary: 'fridays',
      }),
    ]);
    expect(await dreamPerson(REMI, deps(client))).toMatchObject({ status: 'updated' });
    expect(requests).toHaveLength(2);
    const repair = messagesOf(requests[1])[3].content;
    expect(repair).toContain('circle "mtg"');
    expect(repair).toContain(`Nova (id:${NOVA})`);
    const circle = notes.getCircle('mtg');
    expect(circle?.content).toBe('## Now\nFriday drafts.');
    expect(circle?.members.find((m) => m.memberId === NOVA)).toMatchObject({ until: '2023' });
    expect(notes.circlesOf(NOVA, { includeFormer: true }).map((c) => c.circle.topic)).toEqual(['mtg']);
  });

  it('fails (the circle untouched) when the repair drops them too; the group pass is held to it as well', async () => {
    withNova();
    await saveFact('Drafts on Fridays with Dale.');
    const dropped = reply({ notes: [newProfile()], circles: [mtg([{ id: REMI }, { id: NOVA }])], change_summary: 'x' });
    const person = createCapturingClient([dropped, dropped]);
    const outcome = await dreamPerson(REMI, deps(person.client));
    expect(outcome.status === 'failed' ? outcome.error : '').toContain(`Dale (id:${DALE})`);
    expect(notes.getCircle('mtg')?.members.map((m) => m.memberId)).toEqual([REMI, DALE, NOVA]);

    await memory.save({ category: 'vibe', subject: 'server', content: 'Friday drafts are sacred.' });
    const groupAnswer = reply({ notes: [], circles: [mtg([{ id: DALE }, { id: NOVA, until: '2023' }])], change_summary: 'x' });
    const groupRun = createCapturingClient([groupAnswer, groupAnswer]);
    const groupOutcome = await dreamGroup(deps(groupRun.client), { personChanges: [] });
    expect(groupOutcome.status === 'failed' ? groupOutcome.error : '').toContain(`Remi (id:${REMI})`);
    expect(notes.getCircle('mtg')?.members.map((m) => m.memberId)).toEqual([REMI, DALE, NOVA]);
  });

  it('counts a member stored under a since-linked side account as listed by their main id', async () => {
    const saved = notes.writeCircles(
      [{ slug: 'duo', title: 'The duo', content: 'Old friends.', members: [{ id: REMI_ALT }, { id: NOVA }] }],
      { updatedBy: 'dream', allowedIds: [REMI_ALT] },
    );
    if (!saved.ok) throw new Error(saved.errors.join('; '));
    vi.stubEnv('LINKED_ACCOUNTS', `${REMI_ALT}:${REMI}`);
    await memory.save({ category: 'vibe', subject: 'server', content: 'The duo is inseparable.' });
    const { client } = createCapturingClient([
      reply({
        notes: [],
        circles: [{ slug: 'duo', title: 'The duo', content: 'Inseparable.', members: [{ id: REMI }, { id: NOVA }] }],
        change_summary: 'duo',
      }),
    ]);
    expect(await dreamGroup(deps(client), { personChanges: [] })).toMatchObject({ status: 'updated' });
    expect(notes.getCircle('duo')?.members.map((m) => m.memberId).sort()).toEqual([REMI, NOVA].sort());
  });

  it('leaves the owner free to remove a member with an edit', async () => {
    withNova();
    const { client } = createCapturingClient([reply({ circles: [mtg([{ id: REMI }, { id: DALE }])], change_summary: 'x' })]);
    const proposal = await proposeEdit(
      { target: { scope: 'circle', slug: 'mtg' }, instruction: 'Nova was never in it', requestedBy: NOVA },
      deps(client),
    );
    if (!proposal.ok) throw new Error(proposal.error);
    expect(applyEdit(proposal, 'Nova was never in it', notes).ok).toBe(true);
    expect(notes.getCircle('mtg')?.members.map((m) => m.memberId)).toEqual([REMI, DALE]);
  });
});

describe('dreamPerson evidence passages', () => {
  const CHANNEL = '100000000000000050';
  const T0 = Date.UTC(2026, 7, 3, 1, 0); // 2026-08-02 21:00 ET
  let archive: ArchiveStore;

  beforeEach(() => {
    vi.stubEnv('ARCHIVE_ENABLED', 'true');
    archive = new ArchiveStore(':memory:');
    setArchiveStoreForTesting(archive);
    archive.upsertChannel({ id: CHANNEL, guildId: GUILD_ID, name: 'bagel-bar', parentId: null, type: ChannelType.GuildText });
  });

  afterEach(() => {
    setArchiveStoreForTesting(undefined);
    archive.close();
  });

  function message(minutes: number, content: string, authorId = DALE, authorName = 'Dale') {
    const createdAt = T0 + minutes * 60_000;
    return archiveInput({ id: snowflake(createdAt), createdAt, channelId: CHANNEL, authorId, authorName, content });
  }

  it('rereads the cited messages of contested claims first (the archive by default), within the cap', async () => {
    const claim = message(2, 'remi moved to laval lol');
    archive.upsertMessages([message(0, 'where is everyone'), message(1, 'at the bakery', REMI, 'Remi'), claim]);
    await memory.save({
      category: CORRECTION_CATEGORY,
      subject: 'Remi',
      subject_user_id: REMI,
      said_by: DALE,
      content: 'Moved to Laval.',
      source: 'correction',
      evidence: { messageIds: [claim.id], quote: 'remi moved to laval lol' },
    });
    await saveFact('Posts bread photos at dawn.', { evidence: { messageIds: ['1300000000000000999'] } });

    const { client, requests } = createCapturingClient([reply({ notes: [newProfile()], change_summary: 'x' })]);
    await dreamPerson(REMI, { notes, memory, client, now: () => NOW });
    const user = userPrompt(requests[0]);
    expect(user).toContain('PASSAGES (the messages behind key entries');
    expect(user).toMatch(/For #\d+ \(a contested claim\):\n#bagel-bar\n/);
    expect(user).toContain('>> 2026-08-02 21:02 Dale: remi moved to laval lol');
    expect(user).toContain('   2026-08-02 21:01 Remi: at the bakery');
  });

  it('dreams without passages when reading them fails', async () => {
    await saveFact('Posts bread photos at dawn.', { evidence: { messageIds: ['1300000000000000999'] } });
    const seen: string[][] = [];
    const loadPassages = (ids: string[]): EvidencePassage[] => {
      seen.push(ids);
      throw new Error('archive locked');
    };
    const { client, requests } = createCapturingClient([reply({ notes: [newProfile()], change_summary: 'x' })]);
    expect(await dreamPerson(REMI, deps(client, { loadPassages }))).toMatchObject({ status: 'updated' });
    expect(seen).toEqual([['1300000000000000999']]);
    expect(userPrompt(requests[0])).not.toContain('PASSAGES');
  });
});

describe('dreamGroup', () => {
  it('skips when the group has no new rows, whatever the people changed', async () => {
    const { client, requests } = createCapturingClient([]);
    const outcome = await dreamGroup(deps(client), {
      personChanges: [{ ownerId: REMI, name: 'Remi', changeSummary: 'new job' }],
    });
    expect(outcome).toEqual({ status: 'skipped', owner: group, reason: 'nothing-new' });
    expect(requests).toHaveLength(0);
  });

  it("writes the group's notes and any circle from the server's rows and tonight's person changes", async () => {
    await memory.save({ category: 'vibe', subject: 'server', content: 'Roasts are affection here.' });
    const { client, requests } = createCapturingClient([
      reply({
        notes: [{ topic: 'vibe', title: 'Vibe', content: '## Now\nRoasts are affection (since 2021).' }],
        circles: [
          {
            slug: 'night-owls',
            title: 'The night owls',
            content: '## Now\nUp at 3am.',
            members: [{ id: DALE }, { id: NOVA }],
          },
        ],
        change_summary: 'vibe: roasts',
      }),
    ]);
    const outcome = await dreamGroup(deps(client), {
      personChanges: [{ ownerId: REMI, name: 'Remi', changeSummary: 'new job' }],
    });
    expect(outcome).toMatchObject({ status: 'updated', changeSummary: 'vibe: roasts', owner: group });
    expect(notes.getNote(group, 'vibe')?.updatedBy).toBe('dream');
    expect(notes.getCircle('night-owls')?.members).toHaveLength(2);
    expect(notes.getDreamState(group).journalWatermark).toBe(notes.journalHighWater());

    const [system, user] = messagesOf(requests[0]);
    expect(system.content).toContain('consolidate your notes on the GROUP as a whole');
    expect(requests[0].headers.get('X-Frigidaire-Feature')).toBe('memory_dream');
    expect(user.content).toContain('PERSON CHANGES since your last group dream:\n- Remi: new job');
    expect(user.content).toContain('Roasts are affection here.');
    expect(user.content).toContain('GROUP NOTES: none yet.');
    expect(user.content).toContain('<circle slug="magic"');
  });
});

describe('planGroupDream (the group pass: new rows, or the weekly refresh)', () => {
  const DAY = 24 * 60 * 60_000;
  /** The same memory.db through a store whose clock reads `at`: versions and dream stamps written then. */
  const storeAt = (at: Date) => new NotesStore(memory, { now: () => at });

  it('runs on new server rows, whenever the group last dreamed', async () => {
    notes.recordDreamSuccess(group, 0);
    await memory.save({ category: 'vibe', subject: 'server', content: 'Movie night is Fridays.' });
    expect(planGroupDream(deps(undefined), NOW)).toMatchObject({ run: true, why: 'new-rows' });
  });

  it('without new rows, refreshes once the last group dream is a week old and a person changed since', () => {
    const lastWeek = new Date(NOW.getTime() - (GROUP_REFRESH_DAYS + 1) * DAY);
    storeAt(lastWeek).recordDreamSuccess(group, 0);
    const fiveDaysAgo = new Date(NOW.getTime() - 5 * DAY);
    storeAt(fiveDaysAgo).writeNotes(dale, [{ topic: 'profile', title: 'Dale', content: '## Now\nPlays Deadlock.' }], {
      updatedBy: 'dream',
      reason: 'started Deadlock',
    });
    const plan = planGroupDream(deps(undefined), NOW);
    expect(plan).toMatchObject({ run: true, why: 'weekly-refresh' });
    // Remi's notes (set up without a reason) count as a change, but only reasons are listed.
    expect(plan).toMatchObject({ changedNotes: 5 });
    expect(plan.run && plan.context.personChanges).toEqual([
      { ownerId: DALE, name: 'Dale', changeSummary: 'started Deadlock (2026-09-21)' },
    ]);
  });

  it('does not refresh within the week, or when nothing changed since', () => {
    const threeDaysAgo = new Date(NOW.getTime() - 3 * DAY);
    storeAt(threeDaysAgo).recordDreamSuccess(group, 0);
    notes.writeNotes(dale, [{ topic: 'profile', title: 'Dale', content: '## Now\nPlays Deadlock.' }], {
      updatedBy: 'dream',
      reason: 'started Deadlock',
    });
    expect(planGroupDream(deps(undefined), NOW)).toEqual({ run: false });

    // A week later, but every change predates that dream.
    notes.recordDreamSuccess(group, 0);
    expect(planGroupDream(deps(undefined), new Date(NOW.getTime() + 8 * DAY))).toEqual({ run: false });
  });

  it('refreshes a group that never dreamed once someone has notes', () => {
    expect(planGroupDream(deps(undefined), NOW)).toMatchObject({ run: true, why: 'weekly-refresh' });
  });
});

describe('summarizePersonChanges', () => {
  const change = (ownerId: string | null, reason: string | null, extra: Partial<NoteChange> = {}): NoteChange => ({
    noteId: 1,
    scope: ownerId ? 'person' : 'circle',
    ownerId,
    topic: 'profile',
    title: 'x',
    version: 2,
    updatedAt: '2026-09-24 12:00:00',
    updatedBy: 'dream',
    reason,
    ...extra,
  });
  const nameOf = (id: string) => ({ [REMI]: 'Remi', [DALE]: 'Dale' })[id];

  it('says each change once per person, dated, with owner edits marked; circles and blank reasons left out', () => {
    const summaries = summarizePersonChanges(
      [
        change(REMI, 'new job'),
        change(REMI, 'new job', { topic: 'work' }),
        change(null, 'new job', { topic: 'mtg' }),
        change(DALE, null),
        change(REMI, 'he never quit Valorant', { updatedBy: 'edit', updatedAt: '2026-09-26 02:00:00' }),
      ],
      nameOf,
    );
    expect(summaries).toEqual([
      { ownerId: REMI, name: 'Remi', changeSummary: 'new job (2026-09-24); owner edit: he never quit Valorant (2026-09-25)' },
    ]);
  });

  it('keeps the newest four changes per person', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((r) => change(REMI, `change ${r}`));
    expect(summarizePersonChanges(many, nameOf)[0].changeSummary).toBe(
      'change b (2026-09-24); change c (2026-09-24); change d (2026-09-24); change e (2026-09-24)',
    );
  });
});

describe('runNightlyDream', () => {
  it('dreams everyone pending, most recently active first, then the group, and sums the cost', async () => {
    await saveFact('Works day shifts.');
    await memory.save({ category: 'fact', subject: 'Dale', subject_user_id: DALE, content: 'Dale plays Deadlock.' });
    await memory.save({ category: 'vibe', subject: 'server', content: 'Movie night is Fridays.' });
    const { client, requests } = createCapturingClient([
      reply({ notes: [{ topic: 'profile', title: 'Dale', content: '## Now\nPlays Deadlock.' }], change_summary: 'deadlock' }, { cost: 0.01 }),
      reply({ notes: [newProfile()], change_summary: 'day shifts' }, { cost: 0.02 }),
      reply({ notes: [{ topic: 'lore', title: 'Lore', content: '## Now\nMovie night Fridays.' }], change_summary: 'movie night' }, { cost: 0.005 }),
    ]);
    const result = await runNightlyDream(deps(client));

    expect(result.day).toBe('2026-09-26');
    expect(result.people.map((o) => [o.owner.scope === 'person' ? o.owner.ownerId : 'group', o.status])).toEqual([
      [DALE, 'updated'],
      [REMI, 'updated'],
    ]);
    expect(result.group).toMatchObject({ status: 'updated', changeSummary: 'movie night' });
    expect(result.costUsd).toBeCloseTo(0.035);
    expect(userPrompt(requests[2])).toContain(
      'PERSON CHANGES since your last group dream:\n- Dale: deadlock (2026-09-26)\n- Remi: day shifts (2026-09-26)',
    );
    expect(notes.pendingDreams()).toEqual({ people: [] });
  });

  it('dreams at most maxPeople a night; the rest wait', async () => {
    notes.recordDreamSuccess(group, 0); // the group dreamed tonight already: no refresh due
    await saveFact('Works day shifts.');
    await memory.save({ category: 'fact', subject: 'Dale', subject_user_id: DALE, content: 'Dale plays Deadlock.' });
    const { client } = createCapturingClient([
      reply({ notes: [{ topic: 'profile', title: 'Dale', content: '## Now\nPlays Deadlock.' }], change_summary: 'x' }),
    ]);
    const result = await runNightlyDream({ ...deps(client), maxPeople: 1 });
    expect(result.people).toHaveLength(1);
    expect(result.group).toMatchObject({ status: 'skipped' });
    expect(notes.pendingDreams().people.map((p) => p.owner)).toEqual([remi]);
  });

  it('stops after three failures in a row and skips the group', async () => {
    const people = ['100000000000000004', '100000000000000005', '100000000000000006', '100000000000000007'];
    for (const id of people) {
      memory.upsertIdentity(id, `Member ${id.slice(-1)}`);
      await memory.save({ category: 'fact', subject: `Member ${id.slice(-1)}`, subject_user_id: id, content: `Likes the number ${id.slice(-1)}.` });
    }
    await memory.save({ category: 'vibe', subject: 'server', content: 'Movie night is Fridays.' });
    const outage = { status: 400, body: { error: { message: 'provider unavailable' } } };
    const { client, requests } = createCapturingClient([outage, outage, outage]);
    const result = await runNightlyDream(deps(client));
    expect(result.people.map((o) => o.status)).toEqual(['failed', 'failed', 'failed']);
    expect(result.group).toBeUndefined();
    expect(requests).toHaveLength(3);
    expect(notes.pendingDreams().people).toHaveLength(4);
  });

  it('never lets refused answers stop the night, and dreams the people whose dreams failed last the next night', async () => {
    notes.recordDreamSuccess(group, notes.journalHighWater()); // no group pass tonight
    // Dale is the least recently active; three members whose answers keep being refused come first tonight.
    await memory.save({ category: 'fact', subject: 'Dale', subject_user_id: DALE, content: 'Dale plays Deadlock.' });
    const stubborn = ['100000000000000004', '100000000000000005', '100000000000000006'];
    for (const id of stubborn) {
      memory.upsertIdentity(id, `Member ${id.slice(-1)}`);
      await memory.save({ category: 'fact', subject: `Member ${id.slice(-1)}`, subject_user_id: id, content: `Likes ${id.slice(-1)}.` });
    }
    const refused = reply('not json at all');
    const { client, requests } = createCapturingClient([
      ...Array.from({ length: 6 }, () => refused), // each stubborn dream: the answer and its repair round
      reply({ notes: [{ topic: 'profile', title: 'Dale', content: '## Now\nPlays Deadlock.' }], change_summary: 'x' }),
    ]);
    const night = await runNightlyDream(deps(client));
    expect(night.people.map((o) => [o.owner.scope === 'person' ? o.owner.ownerId : '', o.status])).toEqual([
      ...stubborn.map((id) => [id, 'failed']).reverse(),
      [DALE, 'updated'],
    ]);
    expect(night.people.slice(0, 3).map((o) => (o.status === 'failed' ? o.cause : ''))).toEqual(['answer', 'answer', 'answer']);
    expect(requests).toHaveLength(7);

    // Tomorrow, someone with new rows is dreamed before the three whose dreams failed.
    await saveFact('Works day shifts.');
    expect(notes.pendingDreams().people.map((p) => (p.owner.scope === 'person' ? p.owner.ownerId : ''))).toEqual([
      REMI,
      ...[...stubborn].reverse(),
    ]);
    expect(notes.pendingDreams({ limit: 1 }).people.map((p) => p.owner)).toEqual([remi]);
  });

  it('refreshes the group weekly from the people changes alone, reading no journal rows', async () => {
    const lastWeek = new Date(NOW.getTime() - (GROUP_REFRESH_DAYS + 2) * 24 * 60 * 60_000);
    await memory.save({ category: 'vibe', subject: 'server', content: 'Movie night is Fridays.' });
    new NotesStore(memory, { now: () => lastWeek }).recordDreamSuccess(group, notes.journalHighWater());
    await saveFact('Works day shifts.');
    const { client, requests } = createCapturingClient([
      reply({ notes: [newProfile()], change_summary: 'day shifts' }),
      reply({ notes: [{ topic: 'vibe', title: 'Vibe', content: '## Now\nRemi works days now.' }], change_summary: 'vibe' }),
    ]);
    const watermark = notes.getDreamState(group).journalWatermark;
    const result = await runNightlyDream(deps(client));
    expect(result.group).toMatchObject({ status: 'updated', changeSummary: 'vibe' });
    const user = userPrompt(requests[1]);
    expect(user).toContain('NEW JOURNAL: nothing new.');
    expect(user).toContain('- Remi: day shifts (2026-09-26)');
    expect(notes.getDreamState(group)).toMatchObject({ journalWatermark: watermark, lastDreamAt: '2026-09-26 08:30:00' });
  });

  it('does nothing without an OpenRouter key', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    await saveFact('Works day shifts.');
    expect(await runNightlyDream({ notes, memory, now: () => NOW })).toEqual({ day: '2026-09-26', people: [] });
    expect(notes.getDreamState(remi).lastError).toBeNull();
  });
});

describe('runDreamsUntilCaughtUp (the built-in bootstrap)', () => {
  const insertRows = (count: number, subject: string, subjectUserId: string | null, category = 'fact') => {
    const insert = memory
      .sharedDatabase()
      .prepare('INSERT INTO memories (category, subject, content, source, subject_user_id) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < count; i++) insert.run(category, subject, `${subject} fact number ${i}.`, 'bootstrap', subjectUserId);
  };

  it('dreams a person again and again until their whole backlog is folded in, then the group', async () => {
    insertRows(MAX_JOURNAL_ROWS_PER_DREAM + 40, 'Remi', REMI);
    insertRows(MAX_JOURNAL_ROWS_PER_DREAM + 1, 'server', null, 'vibe');
    const { client, requests } = createCapturingClient([
      reply({ notes: [newProfile()], change_summary: 'first 300' }, { cost: 0.1 }),
      reply({ notes: [newProfile('## Now\nDay shifts, and the rest.')], change_summary: 'the rest' }, { cost: 0.05 }),
      reply({ notes: [{ topic: 'lore', title: 'Lore', content: '## Now\nOld lore.' }], change_summary: 'lore' }),
      reply({ notes: [{ topic: 'lore', title: 'Lore', content: '## Now\nAll the lore.' }], change_summary: 'more lore' }),
    ]);
    const result = await runDreamsUntilCaughtUp(deps(client));

    expect(result.people.map((o) => o.status)).toEqual(['updated', 'updated']);
    expect(result.group).toMatchObject({ status: 'updated', changeSummary: 'more lore' });
    expect(result).toMatchObject({ passes: 4, caughtUp: true });
    expect(result.costUsd).toBeCloseTo(0.21);
    expect(userPrompt(requests[0])).toContain(`NEW JOURNAL (${MAX_JOURNAL_ROWS_PER_DREAM} entries`);
    expect(userPrompt(requests[1])).toContain('NEW JOURNAL (40 entries');
    expect(userPrompt(requests[3])).toContain('NEW JOURNAL (1 entry');
    expect(notes.pendingDreams()).toEqual({ people: [] });
  });

  it('never retries a failed person in the same run, and stops after three failures in a row', async () => {
    insertRows(MAX_JOURNAL_ROWS_PER_DREAM + 1, 'Remi', REMI);
    const outage = { status: 400, body: { error: { message: 'provider unavailable' } } };
    const once = createCapturingClient([outage, outage]);
    const result = await runDreamsUntilCaughtUp(deps(once.client));
    // Remi's dream fails and is not retried (the nightly dream will); the group's first refresh fails too.
    expect(result.people.map((o) => o.status)).toEqual(['failed']);
    expect(result.group).toMatchObject({ status: 'failed' });
    expect(once.requests).toHaveLength(2);
    expect(result.caughtUp).toBe(false);

    for (const id of ['100000000000000004', '100000000000000005']) {
      memory.upsertIdentity(id, `Member ${id.slice(-1)}`);
      insertRows(1, `Member ${id.slice(-1)}`, id);
    }
    const down = createCapturingClient([outage, outage, outage, outage]);
    const stopped = await runDreamsUntilCaughtUp(deps(down.client));
    expect(stopped.people.map((o) => o.status)).toEqual(['failed', 'failed', 'failed']);
    expect(stopped.group).toBeUndefined();
    expect(down.requests).toHaveLength(3);
  });

  it('dreams nothing while the nightly dream holds the lease, and holds it itself while it runs', async () => {
    insertRows(2, 'Remi', REMI);
    const nightly = takeDreamLease(memory, 'the nightly dream');
    if (!nightly.ok) throw new Error('lease busy');
    const { client, requests } = createCapturingClient([
      reply({ notes: [newProfile()], change_summary: 'x' }),
      reply({ notes: [{ topic: 'vibe', title: 'Vibe', content: '## Now\nChill.' }], change_summary: 'vibe' }),
    ]);
    const busy = await runDreamsUntilCaughtUp(deps(client));
    expect(busy).toMatchObject({ people: [], passes: 0, caughtUp: false, busy: { holder: 'the nightly dream' } });
    expect(requests).toHaveLength(0);
    nightly.lease.release();

    let heldDuringRun: boolean | undefined;
    const watching = createCapturingClient(
      [
        reply({ notes: [newProfile()], change_summary: 'x' }),
        reply({ notes: [{ topic: 'vibe', title: 'Vibe', content: '## Now\nChill.' }], change_summary: 'vibe' }),
      ],
      {
        onRequest: (_request, index) => {
          if (index > 0) return;
          const other = takeDreamLease(memory, 'the nightly dream');
          heldDuringRun = !other.ok;
          if (other.ok) other.lease.release();
        },
      },
    );
    const run = await runDreamsUntilCaughtUp({ ...deps(watching.client), holder: 'the memory bootstrap (CLI)' });
    expect(run.busy).toBeUndefined();
    expect(run.people.map((o) => o.status)).toEqual(['updated']);
    expect(heldDuringRun).toBe(true);
    expect(memory.getState(DREAM_LEASE_KEY)).toBe('');
  });
});

describe('proposeEdit', () => {
  const edit = (target: Parameters<typeof proposeEdit>[0]['target'], instruction = 'he works days now') => ({
    target,
    instruction,
    requestedBy: NOVA,
  });

  it("drafts a person's edit with the edit model (tag memory_edit) and saves nothing", async () => {
    vi.stubEnv('MEMORY_EDIT_MODEL', 'anthropic/claude-sonnet-5');
    const { client, requests } = createCapturingClient([
      reply({ notes: [{ topic: 'profile', title: 'Remi', content: '## Now\nDay shifts.' }], change_summary: 'day shifts' }),
    ]);
    const proposal = await proposeEdit(edit(remi), deps(client));
    expect(proposal).toMatchObject({ ok: true, target: remi, changeSummary: 'day shifts' });
    if (!proposal.ok) throw new Error(proposal.error);
    expect(proposal.allowedIds).toEqual(expect.arrayContaining([REMI, DALE, NOVA]));
    expect(notes.getProfile(REMI)?.version).toBe(1);
    expect(previewChanges(notes, remi, proposal.output).map((c) => c.key)).toEqual(['profile']);

    const [request] = requests;
    expect(request.headers.get('X-Frigidaire-Feature')).toBe('memory_edit');
    expect(request.body).toMatchObject({ model: 'anthropic/claude-sonnet-5', max_tokens: 16_000, provider: { zdr: true } });
    const [system, user] = messagesOf(request);
    expect(system.content).toContain("The owner's instruction is authoritative");
    expect(user.content).toContain('EDITING: your notes on Remi');
    expect(user.content).toContain("THE OWNER'S INSTRUCTION:\nhe works days now");
    expect(user.content).toContain('<circle slug="mtg"');

    expect(applyEdit(proposal, 'he works days now', notes).ok).toBe(true);
    expect(notes.getProfile(REMI)).toMatchObject({ version: 2, updatedBy: 'edit' });
  });

  it('checks the draft against the store (dry run) and repairs what it would refuse', async () => {
    const { client, requests } = createCapturingClient([
      reply({
        notes: [],
        circles: [{ slug: 'book-club', title: 'Book club', content: 'Books.', members: [{ id: DALE }, { id: NOVA }] }],
        change_summary: 'book club',
      }),
      reply({ notes: [], removed_topics: ['games'], change_summary: 'dropped games' }),
    ]);
    const proposal = await proposeEdit(edit(remi, 'drop the games note'), deps(client));
    expect(proposal).toMatchObject({ ok: true, changeSummary: 'dropped games' });
    expect(messagesOf(requests[1])[3].content).toContain('only change circles they are part of');
    expect(notes.getCircle('book-club')).toBeUndefined();
    expect(notes.getNote(remi, 'games')).toBeDefined();
  });

  it('edits exactly one circle', async () => {
    const circle = {
      slug: 'mtg',
      title: 'The MTG crew',
      content: '## Now\nFriday drafts.',
      aliases: ['the drafters'],
      members: [{ id: REMI }, { id: DALE, until: '2026-09' }, { id: NOVA, since: '2026-09' }],
    };
    const { client, requests } = createCapturingClient([reply({ circles: [circle], change_summary: 'Nova joined' })]);
    const proposal = await proposeEdit(edit({ scope: 'circle', slug: 'MTG' }, 'Nova replaced Dale'), deps(client));
    expect(proposal).toMatchObject({ ok: true, target: { scope: 'circle', slug: 'mtg' } });
    if (!proposal.ok) throw new Error(proposal.error);
    expect(userPrompt(requests[0])).toContain('EDITING: the circle "The MTG crew" (slug "mtg")');
    expect(userPrompt(requests[0])).not.toContain('NOTES:');
    expect(applyEdit(proposal, 'Nova replaced Dale', notes).ok).toBe(true);
    expect(notes.getCircle('mtg')?.aliases).toEqual(['the drafters']);
  });

  it("drafts the group's edit", async () => {
    const { client, requests } = createCapturingClient([
      reply({ notes: [{ topic: 'lore', title: 'Lore', content: '## Now\nThe 2026 LAN.' }], change_summary: 'lore' }),
    ]);
    expect(await proposeEdit(edit(group, 'add the 2026 LAN to the lore'), deps(client))).toMatchObject({ ok: true });
    expect(userPrompt(requests[0])).toContain('EDITING: your notes on the group as a whole');
  });

  it('refuses without a model call: an empty or too-long instruction, a circle that does not exist', async () => {
    const { client, requests } = createCapturingClient([]);
    expect(await proposeEdit(edit(remi, '   '), deps(client))).toEqual({ ok: false, error: 'the instruction is empty' });
    expect(await proposeEdit(edit(remi, 'x'.repeat(4001)), deps(client))).toMatchObject({
      ok: false,
      error: 'the instruction is longer than 4,000 characters',
    });
    expect(await proposeEdit(edit({ scope: 'circle', slug: 'chess' }), deps(client))).toEqual({
      ok: false,
      error: 'there is no circle "chess"',
    });
    expect(requests).toHaveLength(0);
  });

  it('returns the errors when the repair is refused too, and a model error as an error', async () => {
    const { client } = createCapturingClient([reply('nope'), reply('still nope')]);
    const proposal = await proposeEdit(edit(remi), deps(client));
    expect(proposal).toEqual({ ok: false, error: 'the answer is not a JSON object' });

    const failing = createCapturingClient([{ status: 400, body: { error: { message: 'bad model' } } }]);
    const failed = await proposeEdit(edit(remi), deps(failing.client));
    expect(failed.ok).toBe(false);
    expect(failed.ok ? '' : failed.error).toMatch(/^400 /);
  });

  it("stops the model call when the caller gives up (the viewer's deadline), without a repair round", async () => {
    const controller = new AbortController();
    let calls = 0;
    // A provider that never answers: the request only ends when its signal aborts.
    const hanging = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
      });
    }) as unknown as typeof globalThis.fetch;
    const client = new OpenAI({ apiKey: 'test-key', baseURL: 'https://openrouter.ai/api/v1', maxRetries: 0, fetch: hanging });
    const pending = proposeEdit({ ...edit(remi), signal: controller.signal }, deps(client));
    await vi.waitFor(() => expect(calls).toBe(1));
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: 'the draft was stopped: it took too long' });
    expect(calls).toBe(1);
    expect(notes.getProfile(REMI)?.version).toBe(1);
  });
});

describe('dryRunEdit', () => {
  it("returns the store's verdict and leaves nothing behind", () => {
    const before = notes.getVersions(notes.getProfile(REMI)?.id ?? 0);
    const ok = dryRunEdit(
      { notes, memory },
      remi,
      output({ notes: [{ topic: 'profile', title: 'Remi', content: '## Now\nWorks daylight hours.' }], change_summary: '' }),
      [],
    );
    expect(ok.ok).toBe(true);
    expect(notes.getVersions(notes.getProfile(REMI)?.id ?? 0)).toEqual(before);
    expect(notes.getProfile(REMI)?.content).toBe('## Now\nNight shifts.');
    memory.sharedDatabase().exec("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')");
    expect(notes.searchNotes('daylight')).toEqual([]);

    const refused = dryRunEdit(
      { notes, memory },
      dale,
      output({ notes: [{ topic: 'games', title: 'Games', content: 'Deadlock.' }], change_summary: '' }),
      [],
    );
    expect(refused).toEqual({ ok: false, errors: ['a person\'s notes must include the "profile" topic'] });
  });
});
