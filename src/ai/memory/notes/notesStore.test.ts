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
    expect(seqOf(a)).toBe(before + 1);
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
});
