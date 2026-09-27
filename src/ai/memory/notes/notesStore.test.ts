import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../memoryStore';
import { NotesStore, toSqliteUtc } from './notesStore';
import { NOTE_LIMITS } from './schema';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const REMI_ALT = '100000000000000011';
const DALE = '100000000000000002';

let memory: MemoryStore;
let notes: NotesStore;
let clock: Date;

beforeEach(() => {
  clock = new Date('2026-09-20T12:00:00Z');
  memory = new MemoryStore(':memory:');
  notes = new NotesStore(memory, { now: () => clock });
});

afterEach(() => {
  memory.close();
  vi.unstubAllEnvs();
});

function db(): Database.Database {
  return memory.sharedDatabase();
}

function ftsIntegrity(): void {
  db().exec("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')");
  const active = (db().prepare('SELECT COUNT(*) AS n FROM notes WHERE active = 1').get() as { n: number }).n;
  const indexed = (db().prepare('SELECT COUNT(*) AS n FROM notes_fts').get() as { n: number }).n;
  expect(indexed).toBe(active);
}

const remi = { scope: 'person', ownerId: REMI } as const;
const group = { scope: 'group' } as const;
const profile = (content = 'Remi runs the group chat. Plays Valorant since 2024.') => ({
  topic: 'profile',
  title: 'Remi',
  content,
});

describe('NotesStore schema', () => {
  it('creates its tables idempotently on an existing memory.db', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
    const file = path.join(dir, 'memory.db');
    try {
      const first = new MemoryStore(file);
      const firstNotes = new NotesStore(first);
      expect(firstNotes.writeNotes(remi, [profile()], { updatedBy: 'dream' }).ok).toBe(true);
      first.close();

      const second = new MemoryStore(file);
      const secondNotes = new NotesStore(second);
      expect(secondNotes.getProfile(REMI)?.content).toContain('Valorant');
      second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds the versions table\'s "linked" column to a database created before it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
    const file = path.join(dir, 'memory.db');
    try {
      const first = new MemoryStore(file);
      new NotesStore(first).writeNotes(remi, [profile()], { updatedBy: 'dream' });
      first.sharedDatabase().exec('ALTER TABLE note_versions DROP COLUMN linked');
      first.close();

      const second = new MemoryStore(file);
      const secondNotes = new NotesStore(second);
      const columns = second.sharedDatabase().prepare('PRAGMA table_info(note_versions)').all() as { name: string }[];
      expect(columns.map((c) => c.name)).toContain('linked');
      expect(secondNotes.writeNotes(remi, [profile('changed')], { updatedBy: 'dream' }).ok).toBe(true);
      expect(secondNotes.undo(secondNotes.getProfile(REMI)?.id ?? 0).ok).toBe(true);
      second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeNotes', () => {
  it('creates version 1 and records it in the history', () => {
    const result = notes.writeNotes(remi, [profile()], { updatedBy: 'dream', reason: 'first notes' });
    expect(result.ok).toBe(true);
    const note = notes.getProfile(REMI);
    expect(note).toMatchObject({
      scope: 'person',
      ownerId: REMI,
      topic: 'profile',
      version: 1,
      updatedBy: 'dream',
      updatedAt: toSqliteUtc(clock),
      active: true,
    });
    expect(notes.getVersions(note?.id ?? 0)).toEqual([
      expect.objectContaining({ version: 1, reason: 'first notes', updatedBy: 'dream', active: true }),
    ]);
    ftsIntegrity();
  });

  it('writes a new version only when something changed', () => {
    notes.writeNotes(remi, [profile()], { updatedBy: 'dream' });
    const same = notes.writeNotes(remi, [profile()], { updatedBy: 'dream' });
    expect(same).toEqual({ ok: true, written: [], removed: [], unchanged: ['profile'] });

    clock = new Date('2026-09-21T12:00:00Z');
    const changed = notes.writeNotes(remi, [profile('Remi quit Valorant in August 2026.')], {
      updatedBy: 'edit',
      reason: 'owner: he quit',
    });
    expect(changed.ok && changed.written.map((n) => n.version)).toEqual([2]);
    const note = notes.getProfile(REMI);
    expect(note?.version).toBe(2);
    expect(notes.getVersions(note?.id ?? 0).map((v) => v.version)).toEqual([2, 1]);
    expect(notes.getVersion(note?.id ?? 0, 1)?.content).toContain('Plays Valorant');
    ftsIntegrity();
  });

  it('removes a topic as a new, inactive version and can bring it back', () => {
    notes.writeNotes(remi, [profile(), { topic: 'games', title: 'Games', content: 'Valorant, Tarkov.' }], {
      updatedBy: 'dream',
    });
    const removed = notes.writeNotes(remi, [], { updatedBy: 'dream', removeTopics: ['games'] });
    expect(removed.ok && removed.removed.map((n) => [n.topic, n.version, n.active])).toEqual([['games', 2, false]]);
    expect(notes.getNote(remi, 'games')).toBeUndefined();
    expect(notes.listNotes(remi).map((n) => n.topic)).toEqual(['profile']);
    ftsIntegrity();

    const back = notes.writeNotes(remi, [{ topic: 'games', title: 'Games', content: 'Back on Valorant.' }], {
      updatedBy: 'dream',
    });
    expect(back.ok && back.written[0].version).toBe(3);
    ftsIntegrity();
  });

  it('refuses the whole write when one note is invalid (nothing is written)', () => {
    const result = notes.writeNotes(
      remi,
      [profile(), { topic: 'games', title: 'Games', content: `plays with <@${DALE}>` }],
      { updatedBy: 'dream' },
    );
    expect(result.ok).toBe(false);
    expect(notes.listNotes(remi)).toEqual([]);
    ftsIntegrity();
  });

  it("requires a person's profile and never removes it", () => {
    const noProfile = notes.writeNotes(remi, [{ topic: 'games', title: 'Games', content: 'x' }], {
      updatedBy: 'dream',
    });
    expect(noProfile).toEqual({ ok: false, errors: ['a person\'s notes must include the "profile" topic'] });
    notes.writeNotes(remi, [profile()], { updatedBy: 'dream' });
    expect(notes.writeNotes(remi, [], { updatedBy: 'edit', removeTopics: ['profile'] }).ok).toBe(false);
    // Once a profile exists, a single other topic may be written on its own.
    expect(notes.writeNotes(remi, [{ topic: 'games', title: 'Games', content: 'x' }], { updatedBy: 'edit' }).ok).toBe(
      true,
    );
  });

  it('keeps each owner within the topic limit', () => {
    const topics = Array.from({ length: NOTE_LIMITS.maxGroupTopics }, (_, i) => ({
      topic: `t${i}`,
      title: `Topic ${i}`,
      content: 'lore',
    }));
    expect(notes.writeNotes(group, topics, { updatedBy: 'dream' }).ok).toBe(true);
    const over = notes.writeNotes(group, [{ topic: 'one-more', title: 'One more', content: 'x' }], {
      updatedBy: 'dream',
    });
    expect(over).toEqual({ ok: false, errors: [`9 topics, over the limit of ${NOTE_LIMITS.maxGroupTopics}`] });
    // Replacing one topic with another in the same write fits.
    expect(
      notes.writeNotes(group, [{ topic: 'one-more', title: 'One more', content: 'x' }], {
        updatedBy: 'dream',
        removeTopics: ['t0'],
      }).ok,
    ).toBe(true);
  });

  it("allows the person's own ids and the input's ids in the text, nobody else's", () => {
    expect(
      notes.writeNotes(remi, [profile(`Remi (${REMI}) and Dale (${DALE}).`)], { updatedBy: 'dream' }).ok,
    ).toBe(false);
    expect(
      notes.writeNotes(remi, [profile(`Remi (${REMI}) and Dale (${DALE}).`)], {
        updatedBy: 'dream',
        allowedIds: [DALE],
      }).ok,
    ).toBe(true);
  });

  it("files a side account's notes nowhere: notes belong to the main account", () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${REMI_ALT}:${REMI}`);
    const result = notes.writeNotes({ scope: 'person', ownerId: REMI_ALT }, [profile()], { updatedBy: 'dream' });
    expect(result.ok).toBe(false);
    notes.writeNotes(remi, [profile()], { updatedBy: 'dream' });
    // Reading by the side account's id finds the main account's profile.
    expect(notes.getProfile(REMI_ALT)?.ownerId).toBe(REMI);
  });

  it('keeps group notes apart from every person', () => {
    notes.writeNotes(group, [{ topic: 'lore', title: 'Lore', content: 'The fridge incident of 2023.' }], {
      updatedBy: 'bootstrap',
    });
    notes.writeNotes(remi, [profile()], { updatedBy: 'dream' });
    expect(notes.listNotes(group).map((n) => [n.scope, n.ownerId, n.topic])).toEqual([['group', null, 'lore']]);
    expect(notes.listAllNotes().map((n) => n.topic)).toEqual(['profile', 'lore']);
    expect(notes.hasNotes(group)).toBe(true);
    expect(notes.hasNotes({ scope: 'person', ownerId: DALE })).toBe(false);
  });
});

describe('undo', () => {
  it('restores the previous version as a new one', () => {
    notes.writeNotes(remi, [profile('v1 text')], { updatedBy: 'dream' });
    notes.writeNotes(remi, [profile('v2 text')], { updatedBy: 'edit' });
    const id = notes.getProfile(REMI)?.id ?? 0;

    const undone = notes.undo(id);
    expect(undone.ok && [undone.note.version, undone.note.content, undone.note.updatedBy]).toEqual([3, 'v1 text', 'undo']);
    expect(notes.getVersion(id, 3)?.reason).toBe('undo of v2 (back to v1)');
    // Undoing again restores what the first undo replaced.
    const redone = notes.undo(id);
    expect(redone.ok && redone.note.content).toBe('v2 text');
    ftsIntegrity();
  });

  it('brings back a removed topic, and refuses a note with no earlier version', () => {
    notes.writeNotes(remi, [profile(), { topic: 'games', title: 'Games', content: 'Valorant.' }], {
      updatedBy: 'dream',
    });
    const games = notes.getNote(remi, 'games');
    notes.writeNotes(remi, [], { updatedBy: 'dream', removeTopics: ['games'] });
    const back = notes.undo(games?.id ?? 0);
    expect(back.ok && back.note.active).toBe(true);
    expect(notes.getNote(remi, 'games')?.content).toBe('Valorant.');

    expect(notes.undo(notes.getProfile(REMI)?.id ?? 0)).toEqual({
      ok: false,
      error: 'there is no earlier version to go back to',
    });
    expect(notes.undo(999)).toEqual({ ok: false, error: 'no such note' });
    ftsIntegrity();
  });
});

describe('pruneVersions', () => {
  it("keeps each note's newest versions, and every bootstrap and owner-edit version", () => {
    notes.writeNotes(remi, [profile('imported')], { updatedBy: 'bootstrap' });
    notes.writeNotes(remi, [profile('edited by the owner')], { updatedBy: 'edit' });
    for (let night = 1; night <= 8; night++) notes.writeNotes(remi, [profile(`night ${night}`)], { updatedBy: 'dream' });
    notes.writeNotes(group, [{ topic: 'vibe', title: 'Vibe', content: 'Roasts.' }], { updatedBy: 'dream' });
    const id = notes.getProfile(REMI)?.id ?? 0;
    expect(notes.getVersions(id)).toHaveLength(10);

    expect(notes.pruneVersions({ keep: 3 })).toBe(5);
    expect(notes.getVersions(id).map((v) => [v.version, v.updatedBy])).toEqual([
      [10, 'dream'],
      [9, 'dream'],
      [8, 'dream'],
      [2, 'edit'],
      [1, 'bootstrap'],
    ]);
    expect(notes.getVersions(notes.getNote(group, 'vibe')?.id ?? 0)).toHaveLength(1);
    // Undo still has the version before the current one.
    const undone = notes.undo(id);
    expect(undone.ok && undone.note.content).toBe('night 7');
    expect(notes.pruneVersions()).toBe(0);
  });

  it('never keeps fewer than two versions', () => {
    for (let night = 1; night <= 4; night++) notes.writeNotes(remi, [profile(`night ${night}`)], { updatedBy: 'dream' });
    expect(notes.pruneVersions({ keep: 0 })).toBe(2);
    expect(notes.getVersions(notes.getProfile(REMI)?.id ?? 0).map((v) => v.version)).toEqual([4, 3]);
  });
});

describe('searchNotes', () => {
  beforeEach(() => {
    notes.writeNotes(remi, [profile(), { topic: 'work', title: 'Work', content: 'Night shifts at the bakery.' }], {
      updatedBy: 'dream',
    });
    notes.writeNotes(group, [{ topic: 'lore', title: 'Lore', content: 'The great bakery heist of 2022.' }], {
      updatedBy: 'dream',
    });
  });

  it('finds notes by content and title with a highlighted snippet', () => {
    const hits = notes.searchNotes('bakery');
    expect(hits.map((h) => h.note.topic).sort()).toEqual(['lore', 'work']);
    expect(hits[0].snippet).toContain('**bakery**');
    expect(notes.searchNotes('Lore').map((h) => h.note.topic)).toEqual(['lore']);
  });

  it('falls back to any meaningful term, filters by owner, and ignores removed notes', () => {
    expect(notes.searchNotes('bakery shifts unicorn').map((h) => h.note.topic)).toContain('lore');
    expect(notes.searchNotes('bakery', { owner: group }).map((h) => h.note.topic)).toEqual(['lore']);
    notes.writeNotes(remi, [], { updatedBy: 'dream', removeTopics: ['work'] });
    expect(notes.searchNotes('shifts')).toEqual([]);
  });

  it('survives FTS syntax in the query', () => {
    expect(() => notes.searchNotes('"AND OR NOT (* ^ bakery')).not.toThrow();
    expect(notes.searchNotes('   ')).toEqual([]);
  });

  it('rebuilds its index from the active notes', () => {
    expect(notes.rebuildFtsIndex()).toBe(3);
    ftsIntegrity();
  });
});

describe('the journal', () => {
  it('advances journal_seq on every write and on merges into old rows', async () => {
    const a = await memory.save({ category: 'fact', subject: 'Remi', content: 'works nights at the bakery', subject_user_id: REMI });
    const b = await memory.save({ category: 'fact', subject: 'Dale', content: 'plays bass', subject_user_id: DALE });
    const seqOf = (id: number) =>
      (db().prepare('SELECT journal_seq FROM memories WHERE id = ?').get(id) as { journal_seq: number }).journal_seq;
    expect(seqOf(b)).toBeGreaterThan(seqOf(a));
    const before = notes.journalHighWater();

    // A near-duplicate re-observation merges into row `a` (lexical dedup) and moves it past the watermark.
    const merged = await memory.save({
      category: 'fact',
      subject: 'Remi',
      content: 'works nights at the bakery downtown',
      subject_user_id: REMI,
    });
    expect(merged).toBe(a);
    expect(seqOf(a)).toBeGreaterThan(before);
    expect(notes.journalSince(remi, before).map((m) => m.id)).toEqual([a]);

    // Forgetting is not news.
    const high = notes.journalHighWater();
    memory.deactivate(b);
    expect(notes.journalHighWater()).toBe(high);
  });

  it("returns a person's rows by id and by name (id-less rows only), without self-diagnosis", async () => {
    memory.upsertIdentity(REMI, 'Remi', 'remi_r');
    memory.upsertIdentity(DALE, 'Dale');
    const byId = await memory.save({ category: 'fact', subject: 'Remi', content: 'bakery', subject_user_id: REMI });
    const byHandle = await memory.save({ category: 'preference', subject: 'remi_r', content: 'hates cilantro' });
    // Someone else's row that happens to be filed under the same name stays theirs.
    await memory.save({ category: 'fact', subject: 'Remi', content: 'owns a boat', subject_user_id: DALE });
    await memory.save({ category: 'capability_gap', subject: 'Remi', content: 'bot failed', subject_user_id: REMI });

    expect(notes.journalSince(remi, 0).map((m) => m.id)).toEqual([byId, byHandle]);
    expect(notes.journalSince(remi, 0, { limit: 1 }).map((m) => m.id)).toEqual([byHandle]);
  });

  it('never claims an id-less row under a name two members go by for either of them', async () => {
    memory.upsertIdentity(REMI, 'Remi');
    memory.upsertIdentity(DALE, 'Dale');
    memory.updateIdentityMeta(REMI, { irl_name: 'Rem' });
    memory.updateIdentityMeta(DALE, { aliases_add: ['Rem'] });
    // An old row filed under "Rem" with no id: the stamp leaves it alone (ambiguous), and so must the dream.
    const shared = await memory.save({ category: 'fact', subject: 'Rem', content: 'is moving to Laval' });
    const own = await memory.save({ category: 'fact', subject: 'Remi', content: 'bakes sourdough' });
    expect(memory.stampSubjectUserIds().ambiguous).toBe(1);

    expect(notes.journalSince(remi, 0).map((m) => m.id)).toEqual([own]);
    expect(notes.journalSince({ scope: 'person', ownerId: DALE }, 0)).toEqual([]);
    // A caller's own name list (chat turns pass the live display name too) gets the same treatment.
    expect(notes.journalSince({ ...remi, names: ['Remi', 'Rem'] }, 0).map((m) => m.id)).toEqual([own]);
    expect(shared).not.toBe(own);
  });

  it("counts a linked side account's rows as the main account's", async () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${REMI_ALT}:${REMI}`);
    const id = await memory.save({ category: 'fact', subject: 'Remi', content: 'alt fact', subject_user_id: REMI_ALT });
    expect(notes.journalSince(remi, 0).map((m) => m.id)).toEqual([id]);
    expect(notes.pendingDreams().people.map((p) => p.owner)).toEqual([remi]);
  });

  it('keeps the group journal to rows about the server', async () => {
    const vibe = await memory.save({ category: 'vibe', subject: 'server', content: 'friday movie nights' });
    await memory.save({ category: 'pain_point', subject: 'server', content: 'bot too slow' });
    await memory.save({ category: 'fact', subject: 'bot', content: 'is a fridge' });
    await memory.save({ category: 'fact', subject: 'Remi', content: 'bakery', subject_user_id: REMI });
    expect(notes.journalSince(group, 0).map((m) => m.id)).toEqual([vibe]);
  });

  it('shows corrections until a dream folds them in', async () => {
    const fact = await memory.save({ category: 'fact', subject: 'Remi', content: 'plays Valorant', subject_user_id: REMI });
    const correction = await memory.save({
      category: 'correction',
      subject: 'Remi',
      content: 'Quit Valorant in August 2026.',
      subject_user_id: REMI,
      said_by: REMI,
      source: 'correction',
    });
    expect(notes.openCorrections(remi).map((m) => [m.id, m.said_by])).toEqual([[correction, REMI]]);
    expect(notes.newJournal(remi, { kinds: 'observations' }).map((m) => m.id)).toEqual([fact]);

    notes.recordDreamSuccess(remi, notes.journalHighWater());
    expect(notes.openCorrections(remi)).toEqual([]);
    expect(notes.newJournal(remi)).toEqual([]);
  });

  it("never merges two people's corrections", async () => {
    const mine = await memory.save({
      category: 'correction',
      subject: 'Remi',
      content: 'Remi quit Valorant',
      subject_user_id: REMI,
      said_by: REMI,
    });
    const theirs = await memory.save({
      category: 'correction',
      subject: 'Remi',
      content: 'Remi quit Valorant',
      subject_user_id: REMI,
      said_by: DALE,
    });
    expect(theirs).not.toBe(mine);
    expect(memory.compact().removed).toBe(0);
  });
});

describe('dream state', () => {
  it('starts at zero, moves forward only, and keeps the last error', () => {
    expect(notes.getDreamState(remi)).toEqual({ journalWatermark: 0, lastDreamAt: null, lastError: null });
    notes.recordDreamFailure(remi, 'model timed out');
    expect(notes.getDreamState(remi)).toMatchObject({ journalWatermark: 0, lastError: 'model timed out' });

    notes.recordDreamSuccess(remi, 12);
    expect(notes.getDreamState(remi)).toEqual({
      journalWatermark: 12,
      lastDreamAt: toSqliteUtc(clock),
      lastError: null,
    });
    notes.recordDreamSuccess(remi, 5);
    expect(notes.getDreamState(remi).journalWatermark).toBe(12);

    notes.setWatermarks([remi, group, { scope: 'person', ownerId: DALE }], 20);
    expect(notes.getDreamState(remi).journalWatermark).toBe(20);
    expect(notes.getDreamState(group).journalWatermark).toBe(20);
    expect(notes.getDreamState({ scope: 'person', ownerId: DALE })).toEqual({
      journalWatermark: 20,
      lastDreamAt: null,
      lastError: null,
    });
  });

  it('lists the people and the group with new journal rows, most recent first', async () => {
    await memory.save({ category: 'fact', subject: 'Remi', content: 'bakery', subject_user_id: REMI });
    await memory.save({ category: 'fact', subject: 'Dale', content: 'plays bass', subject_user_id: DALE });
    await memory.save({ category: 'vibe', subject: 'server', content: 'movie nights' });

    const pending = notes.pendingDreams();
    expect(pending.people.map((p) => [p.owner, p.newRows])).toEqual([
      [{ scope: 'person', ownerId: DALE }, 1],
      [remi, 1],
    ]);
    expect(pending.group?.newRows).toBe(1);
    expect(notes.pendingDreams({ limit: 1 }).people).toHaveLength(1);

    notes.recordDreamSuccess({ scope: 'person', ownerId: DALE }, notes.journalHighWater());
    notes.recordDreamSuccess(group, notes.journalHighWater());
    expect(notes.pendingDreams()).toEqual({ people: [expect.objectContaining({ owner: remi })] });
  });

  it("never dreams a junk id the old learner left behind, only people the bot knows or a writer vouched for", async () => {
    memory.upsertIdentity(REMI, 'Remi');
    const GARBLED = '100000000000000777';
    const LURKER = '100000000000000888';
    // The old learner copied "456" from its prompt examples, or garbled a snowflake; the stamp leaves such
    // an id in place when the row's name is ambiguous or unknown.
    await memory.save({ category: 'fact', subject: 'Jasper', subject_user_id: '456', content: 'still plays on PS4', source: 'observation' });
    await memory.save({ category: 'fact', subject: 'Nobody', subject_user_id: GARBLED, content: 'likes kites', source: 'observation' });
    // remember_fact about a member who never posted: a real account without an identities row yet.
    await memory.save({ category: 'fact', subject: 'Lurker', subject_user_id: LURKER, content: 'owns a canoe', source: 'conversation' });
    await memory.save({ category: 'fact', subject: 'Remi', subject_user_id: REMI, content: 'bakery', source: 'observation' });

    expect(
      notes
        .pendingDreams()
        .people.map((p) => (p.owner.scope === 'person' ? p.owner.ownerId : ''))
        .sort(),
    ).toEqual([REMI, LURKER].sort());

    // Once the stamp (or a later identities row) makes the garbled id a member, it is dreamed like anyone.
    memory.upsertIdentity(GARBLED, 'Nobody');
    expect(notes.pendingDreams().people.map((p) => (p.owner.scope === 'person' ? p.owner.ownerId : ''))).toContain(
      GARBLED,
    );
  });
});

describe('circles', () => {
  const NOVA = '100000000000000003';
  const mtg = (over: Record<string, unknown> = {}) => ({
    slug: 'mtg',
    title: 'The MTG crew',
    content: '## Now\nFriday drafts at the game store.',
    aliases: ['magic crew'],
    members: [
      { id: REMI, since: '2021' },
      { id: DALE, since: '2021', until: '2023-02' },
    ],
    ...over,
  });

  beforeEach(() => {
    memory.upsertIdentity(REMI, 'Remi');
    memory.upsertIdentity(DALE, 'Dale');
    memory.upsertIdentity(NOVA, 'Nova');
  });

  it('writes a circle with dated membership, versions it and finds it by member', () => {
    const result = notes.writeCircles([mtg()], { updatedBy: 'dream', reason: 'recurring drafts' });
    expect(result.ok).toBe(true);
    const circle = notes.getCircle('MTG');
    expect(circle).toMatchObject({ scope: 'circle', ownerId: null, topic: 'mtg', aliases: ['magic crew'], version: 1 });
    expect(circle?.members).toEqual([
      { memberId: REMI, since: '2021', until: null, role: null },
      { memberId: DALE, since: '2021', until: '2023-02', role: null },
    ]);
    expect(notes.circlesOf(REMI).map((c) => c.circle.topic)).toEqual(['mtg']);
    // A former member is only listed on request.
    expect(notes.circlesOf(DALE)).toEqual([]);
    expect(notes.circlesOf(DALE, { includeFormer: true }).map((c) => c.membership.until)).toEqual(['2023-02']);
    expect(notes.getVersions(circle?.id ?? 0)[0].members).toEqual(circle?.members);
    ftsIntegrity();
  });

  it('files a side account under its main account', () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${REMI_ALT}:${REMI}`);
    notes.writeCircles([mtg({ members: [{ id: REMI_ALT }, { id: DALE }] })], { updatedBy: 'dream' });
    expect(notes.getCircle('mtg')?.members.map((m) => m.memberId)).toEqual([DALE, REMI].sort());
    expect(notes.listCircles({ memberId: REMI_ALT }).map((c) => c.topic)).toEqual(['mtg']);
    const twice = notes.writeCircles([mtg({ slug: 'dup', members: [{ id: REMI_ALT }, { id: REMI }, { id: DALE }] })], {
      updatedBy: 'dream',
    });
    expect(twice.ok).toBe(false);
  });

  it('refuses members nobody knows unless they were in the input', () => {
    const stranger = '100000000000000099';
    const refused = notes.writeCircles([mtg({ members: [{ id: REMI }, { id: stranger }] })], { updatedBy: 'import' });
    expect(refused).toEqual({ ok: false, errors: [`circle "mtg": member ${stranger} is nobody the bot knows`] });
    expect(
      notes.writeCircles([mtg({ members: [{ id: REMI }, { id: stranger }] })], {
        updatedBy: 'import',
        allowedIds: [stranger],
      }).ok,
    ).toBe(true);
  });

  it("writes a person's notes and their circles together, never someone else's circle", () => {
    notes.writeCircles(
      [{ slug: 'dale-and-nova', title: 'Dale & Nova', content: 'Rivals.', members: [{ id: DALE }, { id: NOVA }] }],
      { updatedBy: 'dream' },
    );
    const mine = notes.writeNotes(remi, [profile()], { updatedBy: 'dream', circles: [mtg()] });
    expect(mine.ok && mine.written.map((n) => [n.scope, n.topic])).toEqual([
      ['person', 'profile'],
      ['circle', 'mtg'],
    ]);

    const hijack = notes.writeNotes(remi, [profile('changed')], {
      updatedBy: 'dream',
      circles: [{ slug: 'dale-and-nova', title: 'x', content: 'y', members: [{ id: DALE }, { id: NOVA }, { id: REMI }] }],
    });
    expect(hijack).toEqual({
      ok: false,
      errors: ['circle "dale-and-nova": a person\'s notes only change circles they are part of'],
    });
    // All or nothing: the profile did not change either.
    expect(notes.getProfile(REMI)?.version).toBe(1);
    expect(notes.writeNotes(remi, [], { updatedBy: 'dream', removeCircles: ['dale-and-nova'] }).ok).toBe(false);
  });

  it('merges a duplicate circle into another and removes circles as inactive versions', () => {
    notes.writeCircles([mtg(), mtg({ slug: 'magic', title: 'Magic nights' })], { updatedBy: 'dream' });
    const merged = notes.writeCircles([mtg({ merged_from: ['magic'] })], { updatedBy: 'dream', reason: 'dedupe' });
    expect(merged.ok && merged.removed.map((n) => [n.topic, n.active])).toEqual([['magic', false]]);
    const magic = merged.ok ? merged.removed[0] : undefined;
    expect(notes.getVersion(magic?.id ?? 0, 2)?.reason).toBe('merged into mtg');
    expect(notes.listCircles().map((c) => c.topic)).toEqual(['mtg']);
    // A removed circle keeps its history and comes back with undo.
    notes.writeCircles([], { updatedBy: 'edit', removeCircles: ['mtg'] });
    expect(notes.getCircle('mtg')).toBeUndefined();
    const id = notes.getNoteById(magic?.id ?? 0)?.id ?? 0;
    expect(notes.undo(id).ok).toBe(true);
    expect(notes.getCircle('magic')?.members).toHaveLength(2);
    ftsIntegrity();
  });

  it('undoes a merge whole: the merged-away circle comes back, and undoing the undo merges it again', () => {
    notes.writeCircles([mtg(), mtg({ slug: 'magic', title: 'Magic nights', content: '## Now\nThursday casual games.' })], {
      updatedBy: 'dream',
    });
    // A wrong merge: the writer judged them the same thing.
    notes.writeCircles([mtg({ content: '## Now\nDrafts on Fridays, casual games on Thursdays.', merged_from: ['magic'] })], {
      updatedBy: 'dream',
    });
    expect(notes.getCircle('magic')).toBeUndefined();
    const id = notes.getCircle('mtg')?.id ?? 0;

    const undone = notes.undo(id);
    expect(undone.ok && undone.note.content).toBe('## Now\nFriday drafts at the game store.');
    expect(undone.ok && undone.alsoRestored.map((n) => [n.topic, n.active, n.updatedBy])).toEqual([['magic', true, 'undo']]);
    expect(notes.getCircle('magic')?.content).toBe('## Now\nThursday casual games.');
    expect(notes.getCircle('magic')?.members).toHaveLength(2);
    expect(notes.getVersions(id)[0].reason).toBe('undo of v2 (back to v1; magic too)');

    // Undoing the undo is the merge again, both halves.
    const redone = notes.undo(id);
    expect(redone.ok && redone.note.content).toContain('casual games on Thursdays');
    expect(notes.getCircle('magic')).toBeUndefined();
    ftsIntegrity();
  });

  it('undoes a circle a merge created: it goes, the circles it merged come back', () => {
    notes.writeCircles([mtg(), mtg({ slug: 'magic', title: 'Magic nights' })], { updatedBy: 'dream' });
    notes.writeCircles([mtg({ slug: 'card-crew', title: 'The card crew', merged_from: ['mtg', 'magic'] })], {
      updatedBy: 'edit',
    });
    const created = notes.getCircle('card-crew');
    expect(created?.version).toBe(1);
    expect(notes.canUndo(created?.id ?? 0)).toBe(true);
    // A plain first version has nothing to go back to.
    notes.writeCircles([mtg({ slug: 'solo', title: 'Solo' })], { updatedBy: 'dream' });
    expect(notes.canUndo(notes.getCircle('solo')?.id ?? 0)).toBe(false);

    const undone = notes.undo(created?.id ?? 0);
    expect(undone.ok && [undone.note.active, undone.note.version]).toEqual([false, 2]);
    expect(
      notes
        .listCircles()
        .map((c) => c.topic)
        .sort(),
    ).toEqual(['magic', 'mtg', 'solo']);
    expect(notes.getCircle('card-crew')).toBeUndefined();
    ftsIntegrity();
  });

  it('leaves a merged-away circle alone when something changed it since the merge', () => {
    notes.writeCircles([mtg(), mtg({ slug: 'magic', title: 'Magic nights' })], { updatedBy: 'dream' });
    notes.writeCircles([mtg({ merged_from: ['magic'], content: 'merged' })], { updatedBy: 'dream' });
    const magic = notes.writeCircles([mtg({ slug: 'magic', title: 'Magic nights, revived' })], { updatedBy: 'edit' });
    expect(magic.ok).toBe(true);
    const undone = notes.undo(notes.getCircle('mtg')?.id ?? 0);
    expect(undone.ok && undone.alsoRestored).toEqual([]);
    expect(notes.getCircle('magic')?.title).toBe('Magic nights, revived');
  });

  it('restores the previous membership on undo', () => {
    notes.writeCircles([mtg()], { updatedBy: 'dream' });
    notes.writeCircles([mtg({ members: [{ id: REMI }, { id: NOVA, since: '2026' }] })], { updatedBy: 'edit' });
    const id = notes.getCircle('mtg')?.id ?? 0;
    expect(notes.circlesOf(NOVA).map((c) => c.circle.topic)).toEqual(['mtg']);
    const undone = notes.undo(id);
    expect(undone.ok && undone.note.members.map((m) => m.memberId)).toEqual([REMI, DALE]);
    expect(notes.circlesOf(NOVA)).toEqual([]);
  });

  it('reports an identical rewrite as unchanged', () => {
    notes.writeCircles([mtg()], { updatedBy: 'dream' });
    expect(notes.writeCircles([mtg()], { updatedBy: 'dream' })).toEqual({
      ok: true,
      written: [],
      removed: [],
      unchanged: ['circle:mtg'],
    });
  });

  it('keeps each member within the circle limit', () => {
    const circles = Array.from({ length: NOTE_LIMITS.maxCirclesPerMember + 1 }, (_, i) =>
      mtg({ slug: `c${i}`, members: [{ id: REMI }, { id: DALE }] }),
    );
    const result = notes.writeCircles(circles, { updatedBy: 'dream' });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toContain(
      `member ${REMI} would be in ${NOTE_LIMITS.maxCirclesPerMember + 1} circles, over the limit of ${NOTE_LIMITS.maxCirclesPerMember}`,
    );
    expect(notes.listCircles()).toEqual([]);
  });

  it('applies a validated writer output for a person, the group or one circle', () => {
    const output = {
      notes: [profile()],
      removed_topics: [],
      circles: [{ ...mtg(), aliases: [], members: [{ id: REMI }, { id: DALE }], merged_from: [] }],
      removed_circles: [],
      change_summary: 'first notes',
    };
    const result = notes.applyNotesOutput(remi, output, { updatedBy: 'dream' });
    expect(result.ok).toBe(true);
    expect(notes.getVersions(notes.getCircle('mtg')?.id ?? 0)[0].reason).toBe('first notes');

    const circleEdit = { ...output, notes: [], circles: [{ ...output.circles[0], content: 'Edited.' }] };
    expect(notes.applyNotesOutput({ scope: 'circle', slug: 'mtg' }, circleEdit, { updatedBy: 'edit' }).ok).toBe(true);
    expect(notes.getCircle('mtg')?.content).toBe('Edited.');
    expect(notes.applyNotesOutput({ scope: 'circle', slug: 'other' }, circleEdit, { updatedBy: 'edit' }).ok).toBe(false);
  });

  it('is found by search through its title, content and aliases', () => {
    notes.writeCircles([mtg()], { updatedBy: 'dream' });
    expect(notes.searchNotes('drafts').map((h) => h.note.topic)).toEqual(['mtg']);
    expect(notes.searchNotes('magic crew').map((h) => h.note.topic)).toEqual(['mtg']);
    expect(notes.searchNotes('drafts', { scope: 'person' })).toEqual([]);
    expect(notes.listAllNotes().map((n) => n.scope)).toEqual(['circle']);
  });
});

describe('journal rows about several people', () => {
  it("puts a relationship row in every involved member's journal and pending dream", async () => {
    const NOVA = '100000000000000003';
    const id = await memory.save({
      category: 'fact',
      subject: 'Remi',
      content: 'Remi and Dale have been best friends since school',
      subject_user_id: REMI,
      related_user_ids: [DALE, REMI, 'not-an-id'],
    });
    expect(notes.journalSince({ scope: 'person', ownerId: DALE }, 0).map((m) => m.id)).toEqual([id]);
    expect(notes.journalSince({ scope: 'person', ownerId: NOVA }, 0)).toEqual([]);
    expect(
      notes
        .pendingDreams()
        .people.map((p) => (p.owner.scope === 'person' ? p.owner.ownerId : ''))
        .sort(),
    ).toEqual([REMI, DALE].sort());
    // A correction of someone else only shows as an open correction for the person it is about.
    await memory.save({
      category: 'correction',
      subject: 'Remi',
      content: 'Remi moved to Laval',
      subject_user_id: REMI,
      said_by: DALE,
      related_user_ids: [DALE],
    });
    expect(notes.openCorrections({ scope: 'person', ownerId: DALE })).toEqual([]);
    expect(notes.openCorrections(remi)).toHaveLength(1);
  });
});
