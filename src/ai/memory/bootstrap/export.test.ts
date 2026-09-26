import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveStore } from '../../../archive/archiveStore';
import { archiveInput, BOT_USER_ID, snowflake } from '../../../test-support/fakeArchive';
import { MemoryStore } from '../memoryStore';
import { NotesStore } from '../notes/notesStore';
import { ALREADY_COVERED_HEADING, NEW_PART_HEADING } from './transcript';
import { type ExportManifest, runExport } from './export';
import { buildExportPeople, peopleJson } from './people';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const REMI_ALT = '100000000000000011';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const ALEX_A = '100000000000000004';
const ALEX_B = '100000000000000005';
const GONE = '100000000000000006';
const GENERAL = '300000000000000001';
const GAMING = '300000000000000002';
const SECRET = '300000000000000009';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// 2024-03-01 19:00 Eastern.
const START = Date.UTC(2024, 3 - 1, 2, 0, 0);

// A fictional group chat, shaped like the real archive: ~50 characters per message on average (the owner
// measured ~4.6M characters over ~88k messages), people often posting two or three messages in a row.
const LINES = [
  'anyone up for mtg friday? i finally built the dragon deck',
  'yeah i can do 7, might be a bit late because of work',
  'bring the good sleeves this time lol',
  'my deck is still a pile but whatever, it has vibes',
  'did anyone see the new set spoilers from this morning',
  'the green commons look completely busted ngl',
  "i'm not paying 40 bucks for a single card again, never again",
  'the bakery had those cinnamon buns again today and i bought three',
  'save me one please i am begging',
  'too late they are gone, sorry',
  'rip',
  'ok who broke the group calendar, every event is on tuesday now',
  'not me i swear i did not touch it',
  'it was definitely dale, he was in there yesterday',
  'slander. pure slander',
  'anyway traffic on the 40 was insane this morning, took me an hour to get downtown',
  'work from home gang rise up',
  'must be nice, some of us have to show up to an actual office',
  'friday still on? i told my roommate we would be loud',
  'yes 7pm at my place, bring snacks and your own dice',
  'i can bring chips and that weird salsa everyone liked',
  'someone bring actual food please, last time we ate cereal',
  'pizza it is then, i will order when people show up',
  'the valorant patch nerfed my main again and i am so tired of it',
  'you only play one agent anyway so that tracks',
  'because she is the best one and everyone knows it',
  'hot take: the old map was better and they should bring it back',
  'that is not a hot take that is a fact',
  'lmao',
  'i finally finished the book you lent me, the ending was wild and i need to talk about it with someone',
  'right?? the twist with the brother got me so good',
  'no spoilers i am only on chapter 3',
  'good morning everyone, who is awake',
  'it is 2pm',
];
// How many messages each turn holds before someone else talks (the pattern repeats; ~2 on average).
const TURNS = [2, 1, 3, 1, 2, 2, 1, 3, 2, 1];

let tmp: string;
let memory: MemoryStore;
let notes: NotesStore;
let archive: ArchiveStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-export-'));
  vi.stubEnv('LINKED_ACCOUNTS', `${REMI_ALT}:${REMI}`);
  vi.stubEnv('ARCHIVE_IGNORE_CHANNELS', SECRET);
  memory = new MemoryStore(':memory:');
  notes = new NotesStore(memory);
  archive = new ArchiveStore(':memory:');
  memory.upsertIdentity(REMI, 'Remi', 'remi_b');
  memory.upsertIdentity(REMI_ALT, 'Remi phone', 'remi_phone');
  memory.upsertIdentity(DALE, 'Dale', 'dale_d');
  memory.upsertIdentity(NOVA, 'Nova', 'nova_n');
  memory.updateIdentityMeta(NOVA, { irl_name: 'Nova Placeholder', aliases_add: ['Novs'] });
  memory.upsertIdentity(ALEX_A, 'Alex', 'alex_a');
  memory.upsertIdentity(ALEX_B, 'Alex', 'alex_b');
  archive.upsertChannel({ id: GENERAL, guildId: null, name: 'general', parentId: null, type: 0 });
  archive.upsertChannel({ id: GAMING, guildId: null, name: 'gaming', parentId: null, type: 0 });
  archive.upsertChannel({ id: SECRET, guildId: null, name: 'mods', parentId: null, type: 0 });
});

afterEach(() => {
  memory.close();
  archive.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/**
 * Days of fictional conversation: bursts of messages a minute or two apart, quiet hours between bursts,
 * people alternating with occasional double posts.
 */
function seedConversation(days: number): number {
  const authors = [
    { id: REMI, name: 'Remi' },
    { id: DALE, name: 'Dale' },
    { id: NOVA, name: 'Nova' },
    { id: ALEX_A, name: 'Alex' },
  ];
  const rows = [];
  let n = 0;
  let turn = 0;
  for (let day = 0; day < days; day++) {
    for (let burst = 0; burst < 3; burst++) {
      let at = START + day * DAY + burst * 4 * 60 * MIN;
      for (let i = 0; i < 16; ) {
        const author = authors[turn % authors.length];
        const count = TURNS[turn % TURNS.length];
        for (let k = 0; k < count && i < 16; k++, i++) {
          rows.push(
            archiveInput({
              id: snowflake(at, n % 4000),
              channelId: burst === 2 ? GAMING : GENERAL,
              authorId: author.id,
              authorName: author.name,
              content: LINES[n % LINES.length],
              createdAt: at,
            }),
          );
          at += (k + 1 < count ? 0.5 : 1 + (n % 3)) * MIN;
          n++;
        }
        turn++;
      }
    }
  }
  archive.upsertMessages(rows);
  return rows.length;
}

function readManifest(dir: string): ExportManifest {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as ExportManifest;
}

describe('runExport', () => {
  it('writes monthly transcripts, token-sized chunks, people.json and a manifest', async () => {
    const seeded = seedConversation(40);
    await memory.save({ category: 'fact', subject: 'Remi', subject_user_id: REMI, content: 'Works at a bakery.' });
    const outDir = path.join(tmp, 'export');

    const manifest = runExport({
      archive,
      memory,
      notes,
      outDir,
      chunkTokens: 3_000,
      leadInTokens: 200,
      now: () => new Date('2026-09-26T12:00:00Z'),
    });

    expect(manifest.totals.messages).toBe(seeded);
    expect(manifest.months.map((m) => m.month)).toEqual(['2024-03', '2024-04']);
    expect(manifest.months.reduce((n, m) => n + m.messages, 0)).toBe(seeded);
    expect(manifest.chunks.length).toBeGreaterThan(3);
    expect(manifest.chunks.reduce((n, c) => n + c.messages, 0)).toBe(seeded);
    expect(manifest.journal_high_water).toBe(notes.journalHighWater());
    expect(manifest.journal_high_water).toBeGreaterThan(0);
    expect(manifest.exported_at).toBe('2026-09-26T12:00:00.000Z');
    expect(manifest.range.first).toBe('2024-03-01 19:00');

    for (const chunk of manifest.chunks) {
      // Within the target, give or take the lead-in and the title.
      expect(chunk.tokens - chunk.lead_in_tokens).toBeLessThanOrEqual(3_000 + 60);
      expect(fs.existsSync(path.join(outDir, chunk.file))).toBe(true);
    }

    const first = fs.readFileSync(path.join(outDir, 'chunks/0001.md'), 'utf8');
    expect(first.startsWith('# Chunk 0001 of ')).toBe(true);
    expect(first).not.toContain(ALREADY_COVERED_HEADING);
    const second = fs.readFileSync(path.join(outDir, 'chunks/0002.md'), 'utf8').split('\n');
    expect(second[2]).toBe(ALREADY_COVERED_HEADING);
    expect(second[3]).toMatch(/^> \d{4}-\d{2}-\d{2} \(\w+day\) · #\w+$/);
    const newAt = second.indexOf(NEW_PART_HEADING);
    expect(newAt).toBeGreaterThan(3);
    expect(second[newAt + 2]).toMatch(/^## \d{4}-\d{2}-\d{2} \(\w+day\)$/);

    const march = fs.readFileSync(path.join(outDir, 'months/2024-03.md'), 'utf8');
    expect(march.split('\n')[0]).toMatch(/^# 2024-03 · [\d,]+ messages$/);
    expect(march).toContain('## 2024-03-01 (Friday)\n### #general\n19:00 Remi: anyone up for mtg friday');
    // Ids never appear in a transcript line.
    for (const file of [...manifest.months.map((m) => m.file), ...manifest.chunks.map((c) => c.file)]) {
      expect(fs.readFileSync(path.join(outDir, file), 'utf8')).not.toMatch(/\d{15,21}/);
    }

    const people = JSON.parse(fs.readFileSync(path.join(outDir, 'people.json'), 'utf8')) as {
      people: Record<string, { id: string; accounts: string[]; real_name: string | null; nicknames: string[] }>;
    };
    expect(people.people.Remi.id).toBe(REMI);
    expect(people.people.Remi.accounts).toEqual([REMI, REMI_ALT]);
    expect(people.people.Nova.real_name).toBe('Nova Placeholder');
    expect(people.people.Nova.nicknames).toEqual(['Novs']);
    expect(Object.keys(people.people)).not.toContain('Remi phone');
    expect(manifest.people.count).toBe(Object.keys(people.people).length);
  });

  it('keeps the framing (times, names, headers) under 15% of the text on a realistic chat', () => {
    const average = LINES.reduce((n, line) => n + line.length, 0) / LINES.length;
    expect(average).toBeGreaterThan(40);
    expect(average).toBeLessThan(60);
    seedConversation(30);
    const manifest = runExport({ archive, memory, notes, outDir: path.join(tmp, 'export') });
    expect(manifest.totals.framing_ratio).toBeGreaterThan(0);
    expect(manifest.totals.framing_ratio).toBeLessThan(0.15);
  });

  it('leaves out deleted messages and ignored channels, and keeps the bot short', () => {
    const at = START + 60 * MIN;
    archive.upsertMessages([
      archiveInput({ id: snowflake(at), channelId: GENERAL, authorId: DALE, authorName: 'Dale', content: 'kept', createdAt: at }),
      archiveInput({
        id: snowflake(at + MIN),
        channelId: GENERAL,
        authorId: DALE,
        authorName: 'Dale',
        content: 'regret',
        createdAt: at + MIN,
      }),
      archiveInput({ id: snowflake(at + 2 * MIN), channelId: SECRET, authorId: NOVA, authorName: 'Nova', content: 'mods only', createdAt: at + 2 * MIN }),
      archiveInput({
        id: snowflake(at + 3 * MIN),
        channelId: GENERAL,
        authorId: BOT_USER_ID,
        authorName: 'Frigidaire',
        source: 'bot',
        content: 'z'.repeat(1000),
        createdAt: at + 3 * MIN,
      }),
    ]);
    archive.markDeleted([snowflake(at + MIN)], at + 2 * MIN);
    const outDir = path.join(tmp, 'export');
    runExport({ archive, memory, notes, outDir });
    const march = fs.readFileSync(path.join(outDir, 'months/2024-03.md'), 'utf8');
    expect(march).toContain('Dale: kept');
    expect(march).not.toContain('regret');
    expect(march).not.toContain('mods only');
    expect(march).toMatch(/bot: z{100,200}…/);
  });

  it('replaces an earlier export whole, and leaves no partial folder behind', () => {
    const outDir = path.join(tmp, 'export');
    fs.mkdirSync(path.join(outDir, 'chunks'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'chunks/0099.md'), 'stale');
    seedConversation(2);
    runExport({ archive, memory, notes, outDir });
    expect(fs.existsSync(path.join(outDir, 'chunks/0099.md'))).toBe(false);
    expect(fs.existsSync(`${outDir}.partial`)).toBe(false);
    expect(readManifest(outDir).format).toBe('frigidaire-export');
  });

  it('writes an empty but valid export for an empty archive', () => {
    const outDir = path.join(tmp, 'export');
    const manifest = runExport({ archive, memory, notes, outDir });
    expect(manifest.totals.messages).toBe(0);
    expect(manifest.chunks).toEqual([]);
    expect(readManifest(outDir).range).toEqual({ first: null, last: null });
  });
});

describe('buildExportPeople', () => {
  it('names people by their current display name, unique within the export', () => {
    const at = START;
    archive.upsertMessages([
      archiveInput({ id: snowflake(at), authorId: ALEX_A, authorName: 'Alex', content: 'a', createdAt: at }),
      archiveInput({ id: snowflake(at + 1), authorId: ALEX_B, authorName: 'Alex', content: 'b', createdAt: at + 1 }),
      archiveInput({ id: snowflake(at + 2), authorId: ALEX_B, authorName: 'Alex', content: 'c', createdAt: at + 2 }),
      // Someone who left before the bot ever saw them: named by the last name they posted with.
      archiveInput({ id: snowflake(at + 3), authorId: GONE, authorName: 'Old Name', content: 'd', createdAt: at + 3 }),
      archiveInput({ id: snowflake(at + 4), authorId: GONE, authorName: 'Pip', content: 'e', createdAt: at + 4 }),
      // An old relay known only by name: the member who goes by it.
      archiveInput({ id: snowflake(at + 5), authorId: null, authorName: 'Dale', source: 'relay', content: 'f', createdAt: at + 5 }),
      // A name nobody goes by stays as it was archived.
      archiveInput({ id: snowflake(at + 6), authorId: null, authorName: 'Webhook: Thing', content: 'g', createdAt: at + 6 }),
    ]);
    const people = buildExportPeople(memory, archive);
    const byId = new Map(people.people.map((p) => [p.id, p]));
    // The busier Alex keeps the plain name; the other gets their handle.
    expect(byId.get(ALEX_B)?.name).toBe('Alex');
    expect(byId.get(ALEX_A)?.name).toBe('Alex (@alex_a)');
    expect(byId.get(GONE)).toMatchObject({ name: 'Pip', known: false, messages: 2, otherNames: ['Old Name'] });
    expect(byId.get(DALE)?.messages).toBe(1);
    expect(people.authorOf({ authorId: null, authorName: 'Dale', source: 'relay' })).toBe('Dale');
    expect(people.unresolved).toEqual([{ name: 'Webhook: Thing', label: 'Webhook Thing', messages: 1 }]);
    expect(people.authorOf({ authorId: null, authorName: 'Webhook: Thing', source: 'human' })).toBe('Webhook Thing');
    expect(people.byAccount(REMI_ALT)?.name).toBe('Remi');

    const json = peopleJson(people) as { people: Record<string, { id: string }> };
    expect(json.people.Pip.id).toBe(GONE);
  });
});
