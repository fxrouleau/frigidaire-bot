import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveStore } from '../../../archive/archiveStore';
import { logger } from '../../../logger';
import { chatCompletionBody, createCapturingClient } from '../../../test-support/capturingClient';
import { archiveInput, snowflake } from '../../../test-support/fakeArchive';
import { getMemoryStore, getNotesStore } from '../index';
import { MemoryStore } from '../memoryStore';
import type { NightlyDreamResult } from '../notes/dreamer';
import { DREAM_NIGHT_KEY } from '../notes/dreamSchedule';
import { NotesStore } from '../notes/notesStore';
import { type CliDeps, dreamOverStores, openDataStores, parseArgs, runCli } from './commands';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const DALE = '100000000000000002';
const GENERAL = '300000000000000001';
const MARCH = Date.UTC(2019, 2, 2, 0, 0);

let tmp: string;
let memory: MemoryStore;
let notes: NotesStore;
let archive: ArchiveStore;
let out: string[];
let err: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cli-'));
  memory = new MemoryStore(':memory:');
  notes = new NotesStore(memory);
  archive = new ArchiveStore(':memory:');
  memory.upsertIdentity(REMI, 'Remi', 'remi_b');
  memory.upsertIdentity(DALE, 'Dale', 'dale_d');
  archive.upsertChannel({ id: GENERAL, guildId: null, name: 'general', parentId: null, type: 0 });
  archive.upsertMessages([
    archiveInput({ id: snowflake(MARCH), channelId: GENERAL, authorId: REMI, authorName: 'Remi', content: 'bakery at 5am', createdAt: MARCH }),
    archiveInput({ id: snowflake(MARCH + 60_000), channelId: GENERAL, authorId: DALE, authorName: 'Dale', content: 'rip', createdAt: MARCH + 60_000 }),
  ]);
  out = [];
  err = [];
  vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  memory.close();
  archive.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function deps(extra: Partial<CliDeps> = {}): CliDeps {
  return {
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    openStores: () => ({ archive, memory, notes }),
    now: () => new Date('2026-09-26T12:00:00Z'),
    ...extra,
  };
}

describe('parseArgs', () => {
  it('reads positionals, boolean flags and valued flags', () => {
    const args = parseArgs(['dir', '--check', '--people', 'p.json', '--from=2019-03']);
    expect(args.positional).toEqual(['dir']);
    expect([...args.flags]).toEqual([
      ['check', true],
      ['people', 'p.json'],
      ['from', '2019-03'],
    ]);
  });
});

describe('runCli', () => {
  it('prints the usage for no command, and refuses unknown commands and options', async () => {
    expect(await runCli([], deps())).toBe(2);
    expect(out.join('\n')).toContain('usage: memory <command>');
    expect(await runCli(['frobnicate'], deps())).toBe(2);
    expect(err.join('\n')).toContain('unknown command "frobnicate"');
    expect(await runCli(['export', '--colour'], deps())).toBe(2);
    expect(err.join('\n')).toContain('unknown option --colour');
    expect(await runCli(['bootstrap', '--dry-run', '--from', 'March'], deps())).toBe(2);
    expect(err.join('\n')).toContain('--from must be YYYY-MM');
  });

  it('exports the archive and reports the sizes', async () => {
    const outDir = path.join(tmp, 'export');
    expect(await runCli(['export', '--out', outDir, '--chunk-tokens', '5000'], deps())).toBe(0);
    expect(fs.existsSync(path.join(outDir, 'manifest.json'))).toBe(true);
    expect(out[0]).toContain('Exported 2 messages (2019-03-01 19:00 → 2019-03-01 19:01)');
    expect(out.join('\n')).toContain('1 chunk of');
  });

  it('checks a notes tree against a people.json, and explains that the import itself runs at startup', async () => {
    const dir = path.join(tmp, 'final');
    fs.mkdirSync(path.join(dir, 'people', REMI), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ format: 'frigidaire-notes', version: 1, journal_high_water: 0 }));
    fs.writeFileSync(path.join(dir, 'people', REMI, 'profile.md'), '---\ntitle: Remi\n---\n## Now\nBakes bread.');
    fs.writeFileSync(path.join(dir, 'people.json'), JSON.stringify({ people: { Remi: { id: REMI, accounts: [REMI] } } }));
    const openStores = vi.fn(() => ({ archive, memory, notes }));

    expect(await runCli(['import', '--check', dir], deps({ openStores }))).toBe(0);
    expect(out.at(-1)).toContain('OK (known people from');
    expect(out.at(-1)).toContain('It would load 1 person, 0 group topics and 0 circles');
    expect(openStores).not.toHaveBeenCalled();

    fs.writeFileSync(path.join(dir, 'people', REMI, 'games.md'), '---\ntitle: Games\n---\n<@1> hi');
    expect(await runCli(['import', '--check', dir], deps({ openStores }))).toBe(1);
    expect(err.join('\n')).toContain('games.md: note "games": the content contains a Discord mention');

    expect(await runCli(['import', dir], deps())).toBe(2);
    expect(err.at(-1)).toContain('The import runs when the bot starts');
  });

  it('checks against the bot databases when there is no people.json', async () => {
    const dir = path.join(tmp, 'final');
    fs.mkdirSync(path.join(dir, 'people', DALE), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ format: 'frigidaire-notes', version: 1, journal_high_water: 3 }));
    fs.writeFileSync(path.join(dir, 'people', DALE, 'profile.md'), '---\ntitle: Dale\n---\nDrives.');
    expect(await runCli(['import', '--check', dir], deps())).toBe(1);
    expect(err.join('\n')).toContain('journal_high_water 3 is above the journal');
  });

  it('splits the observation log per person', async () => {
    const work = path.join(tmp, 'work');
    fs.mkdirSync(path.join(work, 'observations'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'export'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'export', 'people.json'),
      JSON.stringify({ people: { Remi: { id: REMI, accounts: [REMI] }, Dale: { id: DALE, accounts: [DALE] } } }),
    );
    fs.writeFileSync(
      path.join(work, 'observations', '0001.jsonl'),
      `${JSON.stringify({ people: [REMI, DALE], category: 'fact', kind: 'relationship', content: 'Best friends since school.', date: '2019-03', evidence: [{ chunk: '0001', lines: [4, 9] }] })}\n`,
    );
    expect(await runCli(['observations', work], deps())).toBe(0);
    expect(out.at(-1)).toContain('1 observation in 1 file → by-person/ (2 people), by-circle/ (0 circles); cast.md (0 profiles)');
    expect(fs.readFileSync(path.join(work, 'by-person', `${DALE}.jsonl`), 'utf8')).toContain('Best friends');
  });

  it('refuses a folder that is not the work folder, instead of rebuilding empty views there', async () => {
    const wrong = path.join(tmp, 'work');
    expect(await runCli(['observations', wrong], deps())).toBe(1);
    expect(err.at(-1)).toContain('has no observations/ folder');
    expect(err.at(-1)).toContain('./data/memory-bootstrap/work');
    expect(fs.existsSync(wrong)).toBe(false);
    // A file named like it doesn't count either.
    fs.mkdirSync(wrong);
    fs.writeFileSync(path.join(wrong, 'observations'), '');
    expect(await runCli(['observations', wrong], deps())).toBe(1);
    expect(fs.readdirSync(wrong)).toEqual(['observations']);
  });

  it('prices a dry run without calling the model', async () => {
    const client = vi.fn();
    const code = await runCli(
      ['bootstrap', '--dry-run'],
      deps({ client, priceOf: async () => ({ promptUsdPerToken: 0.000004, completionUsdPerToken: 0.00002 }) }),
    );
    expect(code).toBe(0);
    expect(client).not.toHaveBeenCalled();
    expect(out[0]).toBe('Archive: 2 messages over 1 month → 1 segment (1 still to read).');
    expect(out[1]).toBe('Model: anthropic/claude-opus-5.5 ($4.00/M in, $20.00/M out).');
    expect(out[2]).toMatch(/^Estimated: ~[\d,]+ input \+ ~300 output tokens ≈ \$0\.\d\d\.$/);
  });

  it('runs the bootstrap, then the dream', async () => {
    vi.stubEnv('MEMORY_BOOTSTRAP_MODEL', 'test/bootstrap-model');
    const { client, requests } = createCapturingClient([
      {
        body: chatCompletionBody(
          JSON.stringify({
            observations: [{ category: 'fact', subject_user_id: REMI, content: 'Works at a bakery.', quote: 'bakery at 5am' }],
          }),
        ),
      },
    ]);
    const dream = vi.fn(async (): Promise<NightlyDreamResult> => ({ day: '2026-09-26', people: [] }));
    expect(await runCli(['bootstrap', '--run'], deps({ client: () => client, dream }))).toBe(0);
    expect(requests[0].body.model).toBe('test/bootstrap-model');
    expect(dream).toHaveBeenCalledWith({ archive, memory, notes }, client);
    expect(out.join('\n')).toContain('Done: 1 segment read, 1 journal row');
    expect(out.at(-1)).toBe('Dreamed: 0 people updated.');

    // Resuming a finished run reads nothing new.
    out = [];
    expect(await runCli(['bootstrap', '--dry-run'], deps())).toBe(0);
    expect(out[0]).toContain('(0 still to read)');
    expect(out.at(-1)).toContain('A run is under way: 1 segment done so far (1 journal row');
  });

  it("dreams over the CLI's own stores (passages from its archive) and never claims the nightly dream's day", async () => {
    const answer = (content: unknown) => ({ body: chatCompletionBody(JSON.stringify(content)) });
    const { client, requests } = createCapturingClient([
      answer({
        observations: [{ category: 'fact', subject_user_id: REMI, content: 'Works at a bakery.', quote: 'bakery at 5am' }],
      }),
      answer({
        notes: [{ topic: 'profile', title: 'Remi', content: '## Now\nWorks at a bakery (since 2019-03).' }],
        change_summary: 'bakery',
      }),
      answer({ notes: [{ topic: 'vibe', title: 'Vibe', content: '## Now\nEarly risers.' }], change_summary: 'vibe' }),
    ]);
    expect(await runCli(['bootstrap', '--run'], deps({ client: () => client, dream: dreamOverStores }))).toBe(0);

    // The cited message came from the CLI's archive (the shared one under Vitest is empty).
    const dreamPrompt = (requests[1].body.messages as { content: string }[])[1].content;
    expect(requests[1].headers.get('X-Frigidaire-Feature')).toBe('memory_dream');
    expect(dreamPrompt).toContain('PASSAGES');
    expect(dreamPrompt).toContain('Remi: bakery at 5am');
    // Written to the CLI's stores, nowhere else; the nightly schedule's day is untouched.
    expect(notes.getProfile(REMI)?.content).toContain('Works at a bakery');
    expect(notes.pendingDreams()).toEqual({ people: [] });
    expect(getNotesStore().getProfile(REMI)).toBeUndefined();
    expect(memory.getState(DREAM_NIGHT_KEY)).toBeUndefined();
    expect(getMemoryStore().getState(DREAM_NIGHT_KEY)).toBeUndefined();
    expect(out.at(-1)).toBe('Dreamed: 1 person updated, the group updated.');
  });

  it('refuses a run without a key, and a bootstrap without a mode', async () => {
    expect(await runCli(['bootstrap', '--run'], deps({ client: () => undefined }))).toBe(1);
    expect(err.at(-1)).toContain('OPENROUTER_API_KEY is not set');
    expect(await runCli(['bootstrap'], deps())).toBe(2);
    expect(err.at(-1)).toContain('exactly one of --dry-run or --run');
  });

  it('never creates empty databases where the data folder is missing', () => {
    expect(() => openDataStores(path.join(tmp, 'nowhere'))).toThrow(/archive\.db not found/);
    expect(fs.existsSync(path.join(tmp, 'nowhere'))).toBe(false);
  });
});
