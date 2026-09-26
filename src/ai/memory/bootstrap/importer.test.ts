import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveStore } from '../../../archive/archiveStore';
import { logger } from '../../../logger';
import { archiveInput, snowflake } from '../../../test-support/fakeArchive';
import { MemoryStore } from '../memoryStore';
import { NotesStore } from '../notes/notesStore';
import {
  checkNotesTree,
  importNotesAtStartup,
  knownPeopleFromJson,
  knownPeopleFromStores,
  takeImportReport,
} from './importer';
import { parseFrontMatter, readNotesTree } from './notesTree';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const REMI_ALT = '100000000000000011';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const GONE = '100000000000000006';
const STRANGER = '100000000000000999';

let tmp: string;
let dir: string;
let memory: MemoryStore;
let notes: NotesStore;
let archive: ArchiveStore;
let clock: Date;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-import-'));
  dir = path.join(tmp, 'memory-import');
  vi.stubEnv('LINKED_ACCOUNTS', `${REMI_ALT}:${REMI}`);
  clock = new Date('2026-09-26T12:00:00Z');
  memory = new MemoryStore(':memory:');
  notes = new NotesStore(memory, { now: () => clock });
  archive = new ArchiveStore(':memory:');
  memory.upsertIdentity(REMI, 'Remi', 'remi_b');
  memory.upsertIdentity(DALE, 'Dale', 'dale_d');
  memory.upsertIdentity(NOVA, 'Nova', 'nova_n');
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
  takeImportReport();
});

afterEach(() => {
  memory.close();
  archive.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

const manifest = (highWater: number) =>
  JSON.stringify({ format: 'frigidaire-notes', version: 1, journal_high_water: highWater, source: 'test' });

const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;

const REMI_PROFILE = note('Remi', "Remi, the group's night owl.\n\n## Now\nRuns day shifts at a bakery (since 2026-08).");
const MTG = [
  '---',
  'title: The MTG crew',
  'aliases: ["the drafters"]',
  `members: [{"id": "${REMI}", "since": "2021", "role": "organizer"}, {"id": "${DALE}", "since": "2021", "until": "2023-02"}]`,
  '---',
  '## Now',
  'Friday drafts at the game store (since 2021, most weeks).',
].join('\n');

function goodTree(highWater = 0): Record<string, string> {
  return {
    'manifest.json': manifest(highWater),
    [`people/${REMI}/profile.md`]: REMI_PROFILE,
    [`people/${REMI}/games.md`]: note('Games', '## Now\nDeadlock most evenings (since 2026-08).'),
    [`people/${DALE}/profile.md`]: note('Dale', '## Now\nDale drives everyone home.'),
    'group/lore.md': note('Lore', '## Now\nThe calendar incident of 2024.'),
    'circles/mtg.md': MTG,
  };
}

describe('parseFrontMatter', () => {
  it('reads plain and JSON values and the body', () => {
    const parsed = parseFrontMatter(MTG);
    expect(parsed.ok && parsed.value.fields.title).toBe('The MTG crew');
    expect(parsed.ok && parsed.value.fields.aliases).toEqual(['the drafters']);
    expect(parsed.ok && parsed.value.body).toBe('## Now\nFriday drafts at the game store (since 2021, most weeks).');
  });

  it.each([
    ['no front matter', 'just text', 'must start with a front matter block'],
    ['an unclosed block', '---\ntitle: x\n', 'never closed'],
    ['a line that is not key: value', '---\njust words\n---\n', 'is not "key: value"'],
    ['a repeated key', '---\ntitle: a\ntitle: b\n---\n', 'appears twice'],
    ['broken JSON', '---\naliases: [oops\n---\n', 'not valid JSON'],
  ])('refuses %s', (_label, text, message) => {
    const parsed = parseFrontMatter(text);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain(message);
  });
});

describe('readNotesTree', () => {
  it('reads people, group and circles', () => {
    writeTree(dir, {
      ...goodTree(),
      'NOTES.txt': 'scratch',
      '.DS_Store': 'junk',
      [`people/${REMI}/.profile.md.swp`]: 'junk',
    });
    const read = readNotesTree(dir);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.tree.people.map((p) => [p.id, p.notes.map((n) => n.topic)])).toEqual([
      [REMI, ['games', 'profile']],
      [DALE, ['profile']],
    ]);
    expect(read.tree.group?.map((n) => n.topic)).toEqual(['lore']);
    expect(read.tree.circles?.[0]).toMatchObject({ slug: 'mtg', aliases: ['the drafters'] });
    expect(read.warnings).toEqual([
      '.DS_Store: hidden, ignored',
      'NOTES.txt: not part of a notes tree, ignored',
      `people/${REMI}/.profile.md.swp: hidden, ignored`,
    ]);
  });

  it('lists every problem with the file it is in', () => {
    writeTree(dir, {
      'manifest.json': JSON.stringify({ format: 'frigidaire-notes', version: 1 }),
      [`people/${DALE}/games.md`]: note('Games', 'no profile next to me'),
      [`people/${NOVA}/profile.md`]: note('Nova', `pinging <@${DALE}> <:pog:900000000000000123>`),
      [`people/${NOVA}/Work Stuff.md`]: note('Work', 'x'),
      [`people/${REMI}/profile.md`]: '---\ntitle: Remi\nmood: sleepy\n---\nhi',
      'people/remi/profile.md': REMI_PROFILE,
      'group/vibe.md': note('Vibe', 'y'.repeat(9_000)),
      'circles/duo.md': `---\ntitle: Duo\nmembers: [{"id": "${REMI}"}]\n---\nA pair of one.`,
    });
    const read = readNotesTree(dir);
    expect(read.ok).toBe(false);
    const errors = read.ok ? [] : read.errors;
    const expected = [
      'manifest.json: "journal_high_water" must be a whole number',
      `people/${DALE}: every person needs a profile.md`,
      `people/${NOVA}/profile.md: note "profile": the content contains a Discord mention`,
      `people/${NOVA}/profile.md: note "profile": the content contains custom emoji syntax`,
      `people/${NOVA}/Work Stuff.md: the file name must be a lowercase slug`,
      `people/${REMI}/profile.md: unknown front matter key "mood"`,
      "people/remi: a person's folder is named by their Discord id",
      'group/vibe.md: note "vibe": the content is 9000 characters, over the 8000 limit',
      'circles/duo.md: circle "duo": a circle has at least 2 members',
    ];
    for (const message of expected) expect(errors.some((e) => e.startsWith(message))).toBe(true);
  });

  it('refuses an empty tree and a missing folder', () => {
    writeTree(dir, { 'manifest.json': manifest(0) });
    expect(readNotesTree(dir)).toEqual({
      ok: false,
      errors: ['the tree holds no notes (people/, group/ and circles/ are empty or missing)'],
    });
    expect(readNotesTree(path.join(tmp, 'nope')).ok).toBe(false);
  });
});

describe('importNotesAtStartup', () => {
  async function journalRow(subjectUserId: string, content: string): Promise<number> {
    return memory.save({ category: 'fact', subject: 'x', subject_user_id: subjectUserId, content });
  }

  it('does nothing without a tree', () => {
    expect(importNotesAtStartup({ dir, memory, notes, archive })).toBeUndefined();
    expect(takeImportReport()).toBeUndefined();
  });

  it('loads every note as a bootstrap version, sets the watermarks and moves the tree aside', async () => {
    await journalRow(REMI, 'Works at a bakery.');
    await journalRow(DALE, 'Drives a van.');
    await journalRow(NOVA, 'Plays cello.');
    const highWater = notes.journalHighWater();
    writeTree(dir, goodTree(highWater));

    const outcome = importNotesAtStartup({ dir, memory, notes, archive, now: () => clock });

    expect(outcome).toMatchObject({
      status: 'imported',
      summary: { people: 2, groupTopics: 1, circles: 1, written: 5, removed: 0, watermark: highWater },
    });
    const profile = notes.getProfile(REMI);
    expect(profile).toMatchObject({ updatedBy: 'bootstrap', version: 1, title: 'Remi' });
    expect(notes.getVersions(profile?.id ?? 0)[0].reason).toBe('bootstrap import');
    expect(notes.getCircle('mtg')?.members.map((m) => m.memberId)).toEqual([REMI, DALE]);
    expect(notes.listNotes({ scope: 'group' }).map((n) => n.topic)).toEqual(['lore']);

    // The imported owners' dreams start after the export; Nova (not in the tree) keeps hers at 0.
    expect(notes.getDreamState({ scope: 'person', ownerId: REMI }).journalWatermark).toBe(highWater);
    expect(notes.getDreamState({ scope: 'group' }).journalWatermark).toBe(highWater);
    expect(notes.getDreamState({ scope: 'person', ownerId: NOVA }).journalWatermark).toBe(0);
    expect(notes.pendingDreams().people.map((p) => p.owner)).toEqual([{ scope: 'person', ownerId: NOVA }]);

    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
    const moved = path.join(dir, 'imported-2026-09-26T12-00-00Z');
    expect(fs.existsSync(path.join(moved, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(moved, 'people', REMI, 'profile.md'))).toBe(true);
    expect(takeImportReport()).toBe(
      `🧠 memory import · notes loaded for 2 people, 1 group topic, 1 circle · dreams pick up from journal #${highWater}`,
    );
    expect(takeImportReport()).toBeUndefined();

    // The next start finds nothing to import.
    expect(importNotesAtStartup({ dir, memory, notes, archive })).toBeUndefined();
  });

  it("replaces an imported person's topics and the circles, and leaves everything else alone", () => {
    notes.writeNotes(
      { scope: 'person', ownerId: REMI },
      [
        { topic: 'profile', title: 'Remi', content: 'old profile' },
        { topic: 'valorant', title: 'Valorant', content: 'old topic' },
      ],
      { updatedBy: 'dream' },
    );
    notes.writeNotes({ scope: 'person', ownerId: NOVA }, [{ topic: 'profile', title: 'Nova', content: 'kept' }], {
      updatedBy: 'dream',
    });
    notes.writeCircles(
      [
        {
          slug: 'cello-duo',
          title: 'Cello duo',
          content: 'x',
          aliases: [],
          members: [{ id: NOVA }, { id: DALE }],
          merged_from: [],
        },
      ],
      { updatedBy: 'dream' },
    );
    writeTree(dir, goodTree());

    const outcome = importNotesAtStartup({ dir, memory, notes, archive, now: () => clock });

    expect(outcome?.status).toBe('imported');
    expect(notes.listNotes({ scope: 'person', ownerId: REMI }).map((n) => n.topic)).toEqual(['profile', 'games']);
    expect(notes.getProfile(REMI)).toMatchObject({ version: 2, updatedBy: 'bootstrap' });
    expect(notes.getProfile(NOVA)?.content).toBe('kept');
    expect(notes.getCircle('cello-duo')).toBeUndefined();
    expect(notes.getCircle('mtg')).toBeDefined();
  });

  it('keeps circles and the group as they are when the tree has no such folder', () => {
    notes.writeNotes({ scope: 'group' }, [{ topic: 'vibe', title: 'Vibe', content: 'chaotic' }], { updatedBy: 'dream' });
    writeTree(dir, { 'manifest.json': manifest(0), [`people/${REMI}/profile.md`]: REMI_PROFILE });
    expect(importNotesAtStartup({ dir, memory, notes, archive })?.status).toBe('imported');
    expect(notes.listNotes({ scope: 'group' }).map((n) => n.topic)).toEqual(['vibe']);
    expect(notes.getDreamState({ scope: 'group' }).journalWatermark).toBe(0);
  });

  it('knows people only the archive has seen, under the last name they posted with', () => {
    archive.upsertMessages([
      archiveInput({ id: snowflake(Date.UTC(2019, 0, 1)), authorId: GONE, authorName: 'Old Name', createdAt: Date.UTC(2019, 0, 1) }),
      archiveInput({ id: snowflake(Date.UTC(2019, 5, 1)), authorId: GONE, authorName: 'Pip', createdAt: Date.UTC(2019, 5, 1) }),
    ]);
    writeTree(dir, {
      'manifest.json': manifest(0),
      [`people/${GONE}/profile.md`]: note('Pip', '## Earlier\nBack in 2019, ran the server trivia nights.'),
    });
    const outcome = importNotesAtStartup({ dir, memory, notes, archive, now: () => clock });
    expect(outcome).toMatchObject({ status: 'imported', summary: { identitiesAdded: 1 } });
    expect(memory.getIdentityById(GONE)?.display_name).toBe('Pip');
    expect(notes.getProfile(GONE)?.title).toBe('Pip');
  });

  it.each([
    ['a stranger', { [`people/${STRANGER}/profile.md`]: note('Who', 'x') }, `people/${STRANGER}: nobody`],
    ['a side account', { [`people/${REMI_ALT}/profile.md`]: note('Remi', 'x') }, 'a linked side account'],
    [
      'a circle with a stranger',
      {
        'circles/pair.md': `---\ntitle: Pair\nmembers: [{"id": "${REMI}"}, {"id": "${STRANGER}"}]\n---\nx`,
      },
      `circles/pair.md: member ${STRANGER} is nobody`,
    ],
  ])('loads nothing when the tree names %s, and leaves it in place', (_label, extra, message) => {
    writeTree(dir, { ...goodTree(), ...extra });
    const outcome = importNotesAtStartup({ dir, memory, notes, archive });
    expect(outcome?.status).toBe('refused');
    expect(outcome?.status === 'refused' && outcome.errors.some((e) => e.includes(message))).toBe(true);
    expect(notes.listAllNotes()).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
    expect(takeImportReport()).toMatch(/^⚠️ memory import refused: 1 problem in the notes tree, nothing loaded/);
    expect(logger.error).toHaveBeenCalled();
  });

  it('refuses a high-water mark above this journal (an export of another database)', () => {
    writeTree(dir, goodTree(50));
    const outcome = importNotesAtStartup({ dir, memory, notes, archive });
    expect(outcome?.status === 'refused' && outcome.errors[0]).toContain('journal_high_water 50 is above');
    expect(notes.listAllNotes()).toEqual([]);
  });

  it('rolls everything back when the store refuses one write (all or nothing)', () => {
    // 13 circles for Remi: over the per-member limit, found only by the store.
    const circles: Record<string, string> = {};
    for (let i = 0; i < 13; i++) {
      circles[`circles/c${i}.md`] = `---\ntitle: C${i}\nmembers: [{"id": "${REMI}"}, {"id": "${DALE}"}]\n---\nx`;
    }
    writeTree(dir, { ...goodTree(), ...circles });
    const outcome = importNotesAtStartup({ dir, memory, notes, archive });
    expect(outcome?.status === 'refused' && outcome.errors.join('\n')).toContain('over the limit of 12');
    expect(notes.listAllNotes()).toEqual([]);
    expect(notes.getDreamState({ scope: 'person', ownerId: REMI }).journalWatermark).toBe(0);
    expect(memory.getIdentityById(REMI)).toBeDefined();
  });
});

describe('checkNotesTree', () => {
  it('validates a tree against an export people.json without touching the databases', () => {
    writeTree(dir, goodTree(7));
    const peopleFile = path.join(tmp, 'people.json');
    fs.writeFileSync(
      peopleFile,
      JSON.stringify({
        people: {
          Remi: { id: REMI, accounts: [REMI, REMI_ALT] },
          Dale: { id: DALE, accounts: [DALE] },
        },
      }),
    );
    const known = knownPeopleFromJson(peopleFile);
    expect(known.ok).toBe(true);
    if (!known.ok) return;
    const result = checkNotesTree(dir, known.known);
    expect(result.errors).toEqual([]);
    expect(result.load).toMatchObject({ ok: true, summary: { people: 2, circles: 1, watermark: 7 } });
    expect(notes.listAllNotes()).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);

    // A side account listed in people.json is caught even without LINKED_ACCOUNTS.
    vi.stubEnv('LINKED_ACCOUNTS', '');
    writeTree(dir, { [`people/${REMI_ALT}/profile.md`]: note('Remi', 'x') });
    expect(checkNotesTree(dir, known.known).errors).toEqual([
      `people/${REMI_ALT}: a linked side account; notes belong to its main account (people/${REMI})`,
    ]);
  });

  it('reports a store-level problem the way the import would', () => {
    writeTree(dir, {
      ...goodTree(),
      [`people/${DALE}/profile.md`]: note('Dale', `Friends with ${NOVA}.`),
    });
    const result = checkNotesTree(dir, knownPeopleFromStores(memory));
    expect(result.errors.some((e) => e.includes(`contains a Discord id that wasn't in the input (${NOVA})`))).toBe(
      true,
    );
  });

  it('flags a manifest ahead of the journal it will be imported into', () => {
    writeTree(dir, goodTree(9));
    expect(checkNotesTree(dir, knownPeopleFromStores(memory), { journalHighWater: 3 }).errors).toEqual([
      'manifest.json: journal_high_water 9 is above the journal\'s (3)',
    ]);
  });

  it('refuses a people.json that is not one', () => {
    const file = path.join(tmp, 'people.json');
    fs.writeFileSync(file, '[]');
    expect(knownPeopleFromJson(file)).toMatchObject({ ok: false });
  });
});
