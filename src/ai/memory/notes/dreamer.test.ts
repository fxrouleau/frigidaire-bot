import { ChannelType } from 'discord.js';
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
  previewChanges,
  proposeEdit,
  runNightlyDream,
} from './dreamer';
import { MAX_JOURNAL_ROWS_PER_DREAM } from './dreamPrompts';
import { NotesStore } from './notesStore';
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
    expect(user.content).toContain("TONIGHT'S PERSON CHANGES:\n- Remi: new job");
    expect(user.content).toContain('Roasts are affection here.');
    expect(user.content).toContain('GROUP NOTES: none yet.');
    expect(user.content).toContain('<circle slug="magic"');
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
    expect(userPrompt(requests[2])).toContain("TONIGHT'S PERSON CHANGES:\n- Dale: deadlock\n- Remi: day shifts");
    expect(notes.pendingDreams()).toEqual({ people: [] });
  });

  it('dreams at most maxPeople a night; the rest wait', async () => {
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

  it('does nothing without an OpenRouter key', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    await saveFact('Works day shifts.');
    expect(await runNightlyDream({ notes, memory, now: () => NOW })).toEqual({ day: '2026-09-26', people: [] });
    expect(notes.getDreamState(remi).lastError).toBeNull();
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
