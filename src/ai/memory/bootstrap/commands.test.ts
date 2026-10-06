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
import { takeDreamLease } from '../notes/dreamLease';
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
  // No history import configured unless a test sets one.
  vi.stubEnv('ARCHIVE_BACKFILL_CHANNELS', '');
  vi.stubEnv('MAIN_CHANNEL_ID', '');
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
    expect(out[1]).toBe('Model: z-ai/glm-5.3-flash ($4.00/M in, $20.00/M out).');
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
    expect(out.at(-2)).toBe('Dreamed: 0 people updated.');
    // The bot's search vectors live in its own process: it needs a restart to see rows written here.
    expect(out.at(-1)).toContain('restart it (docker restart frigidaire-bot)');

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
    expect(out.at(-2)).toBe('Dreamed: 1 person updated, the group updated.');
  });

  describe('while the archive is still importing history', () => {
    beforeEach(() => {
      vi.stubEnv('ARCHIVE_BACKFILL_CHANNELS', GENERAL);
      // The bot has paged part of #general's history backwards so far.
      archive.saveBackfillPage(GENERAL, [], { cursorId: snowflake(MARCH), cursorAt: MARCH, fetched: 200, done: false });
    });

    it('refuses the export, and writes nothing', async () => {
      const outDir = path.join(tmp, 'export');
      expect(await runCli(['export', '--out', outDir], deps())).toBe(1);
      expect(err.at(-1)).toContain('Not now: the archive is still importing history (#general (200 messages so far))');
      expect(fs.existsSync(outDir)).toBe(false);
    });

    it('prices a dry run with a warning, and refuses a run before any model call', async () => {
      expect(await runCli(['bootstrap', '--dry-run'], deps())).toBe(0);
      expect(out.at(-1)).toContain('warning: the archive is still importing history (#general (200 messages so far))');

      const client = vi.fn();
      expect(await runCli(['bootstrap', '--run'], deps({ client }))).toBe(1);
      expect(client).not.toHaveBeenCalled();
      expect(err.at(-1)).toContain('history that lands later would never be read');
      expect(memory.getState('memory_bootstrap:progress')).toBeUndefined();
    });

    it('waits for an import that has not started, and goes ahead once it is done', async () => {
      vi.stubEnv('ARCHIVE_BACKFILL_CHANNELS', `${GENERAL},300000000000000002`);
      expect(await runCli(['export', '--out', path.join(tmp, 'export')], deps())).toBe(1);
      expect(err.at(-1)).toContain('channel 300000000000000002 (not started)');

      vi.stubEnv('ARCHIVE_BACKFILL_CHANNELS', GENERAL);
      archive.saveBackfillPage(GENERAL, [], { cursorId: null, cursorAt: null, fetched: 0, done: true });
      expect(await runCli(['export', '--out', path.join(tmp, 'export')], deps())).toBe(0);
    });

    it('only warns about an import stuck on an error (it may never get through)', async () => {
      archive.recordBackfillError(GENERAL, 'Missing Access');
      expect(await runCli(['export', '--out', path.join(tmp, 'export')], deps())).toBe(0);
      expect(out[0]).toBe(
        'warning: the history import of #general (Missing Access) keeps failing: its older history is not in the archive.',
      );
    });

    it('ignores the import state when the backfill is switched off', async () => {
      vi.stubEnv('ARCHIVE_BACKFILL_ENABLED', 'false');
      expect(await runCli(['export', '--out', path.join(tmp, 'export')], deps())).toBe(0);
    });
  });

  it('refuses another --segment-tokens than the run under way started with', async () => {
    memory.setState(
      'memory_bootstrap:progress',
      JSON.stringify({ version: 1, model: 'm', segmentTokens: 20_000, done: [], rows: 0, costUsd: 0 }),
    );
    expect(await runCli(['bootstrap', '--dry-run', '--segment-tokens', '5000'], deps())).toBe(2);
    expect(err.join('\n')).toContain('cut the archive into segments of 20000 tokens');
    expect(await runCli(['bootstrap', '--dry-run'], deps())).toBe(0);
    expect(await runCli(['bootstrap', '--dry-run', '--segment-tokens', '20000'], deps())).toBe(0);
  });

  it("doesn't dream alongside the bot's nightly dream, and says how to resume", async () => {
    const answer = (content: unknown) => ({ body: chatCompletionBody(JSON.stringify(content)) });
    const { client, requests } = createCapturingClient([
      answer({
        observations: [{ category: 'fact', subject_user_id: REMI, content: 'Works at a bakery.', quote: 'bakery at 5am' }],
      }),
    ]);
    const nightly = takeDreamLease(memory, 'the nightly dream');
    if (!nightly.ok) throw new Error('lease busy');
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(await runCli(['bootstrap', '--run'], deps({ client: () => client, dream: dreamOverStores }))).toBe(0);
    nightly.lease.release();
    expect(requests).toHaveLength(1);
    expect(err.at(-1)).toContain('The dream did not run: the nightly dream has been running since');
    expect(err.at(-1)).toContain('Run `memory bootstrap --run` again once it is done');
    expect(notes.pendingDreams().people).toHaveLength(1);
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

describe('archive and seed-activity', () => {
  const OCTOBER = new Date('2026-10-06T16:00:00Z');
  let local: NotesStore;
  const localDeps = (extra: Partial<CliDeps> = {}) =>
    deps({ openStores: () => ({ archive, memory, notes: local }), now: () => OCTOBER, ...extra });
  const trace = (text: string) => ({
    body: { ...(chatCompletionBody(text) as object), usage: { prompt_tokens: 500, completion_tokens: 200, cost: 0.001 } },
  });

  beforeEach(() => {
    local = new NotesStore(memory, { now: () => OCTOBER });
    local.writeCircles(
      [
        {
          slug: 'yugioh',
          title: 'The Yu-Gi-Oh crew',
          content: '## Now\nFriday duels at the card shop.',
          members: [
            { id: REMI, since: '2018' },
            { id: DALE, since: '2018' },
          ],
        },
      ],
      { updatedBy: 'import' },
    );
    local.writeOccasions(
      [
        {
          slug: 'lan-2025',
          title: 'The 2025 LAN',
          content: '## What happened\nA weekend LAN.',
          starts_on: '2025-03-01',
          status: 'past',
          participants: [{ id: REMI }, { id: DALE }],
        },
      ],
      { updatedBy: 'dream' },
    );
  });

  it('lists what it would archive with --dry-run, then archives each with one trace call, holding the dream lease', async () => {
    expect(await runCli(['archive', 'yugioh', 'occasion:lan-2025', '--dry-run'], localDeps())).toBe(0);
    expect(out).toContain('Would archive 2 notes:');
    expect(out).toContain(
      '  - circle yugioh "The Yu-Gi-Oh crew": 2 members (2 current: their memberships end 2026-10); 37 characters → a trace of ≤ 1,200',
    );
    expect(local.getCircle('yugioh')?.status).toBeNull();

    out.length = 0;
    let leaseHeld = false;
    const { client, requests } = createCapturingClient(
      [trace('## History\nFriday duels 2018–2026.'), trace('## History\nA weekend LAN in March 2025.')],
      {
        onRequest: () => {
          const probe = takeDreamLease(memory, 'probe');
          leaseHeld = !probe.ok;
          if (probe.ok) probe.lease.release();
        },
      },
    );
    expect(await runCli(['archive', 'yugioh', 'occasion:lan-2025'], localDeps({ client: () => client }))).toBe(0);
    expect(leaseHeld).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.headers.get('X-Frigidaire-Feature') === 'memory_dream')).toBe(true);
    expect(requests.every((r) => (r.body.provider as { zdr?: boolean }).zdr === true)).toBe(true);
    expect(local.getCircle('yugioh')).toMatchObject({ status: 'archived', content: '## History\nFriday duels 2018–2026.' });
    expect(local.getCircle('yugioh')?.members.map((m) => m.until)).toEqual(['2026-10', '2026-10']);
    expect(local.getVersions(local.getCircle('yugioh')?.id ?? 0)[0].reason).toBe(
      "archived as a trace: the owner's archive command",
    );
    expect(local.getOccasion('lan-2025')?.status).toBe('archived');
    expect(out.at(-1)).toBe('Done: 2 notes archived, $0.0020. Undo is in the notes viewer ("What does Fridge know?").');
    const after = takeDreamLease(memory, 'after');
    expect(after.ok).toBe(true);
    if (after.ok) after.lease.release();

    // Already archived and short: skipped, nothing to do.
    out.length = 0;
    expect(await runCli(['archive', 'yugioh'], localDeps({ client: () => client }))).toBe(0);
    expect(out).toEqual(['circle yugioh is already archived: skipped.', 'Nothing to archive.']);
  });

  it('archives nothing when a slug names nothing (or two things), without a key, or while the bot dreams', async () => {
    expect(await runCli(['archive', 'yugioh', 'yu-gi-oh'], localDeps())).toBe(1);
    expect(err.at(-1)).toBe('Nothing archived: there is no circle or occasion "yu-gi-oh".');
    local.writeOccasions(
      [{ slug: 'yugioh', title: 'Yu-Gi-Oh night', content: 'x', starts_on: '2026-11-01', participants: [{ id: REMI }, { id: DALE }] }],
      { updatedBy: 'dream' },
    );
    expect(await runCli(['archive', 'yugioh'], localDeps())).toBe(1);
    expect(err.at(-1)).toContain('"yugioh" is both a circle and an occasion: say circle:yugioh or occasion:yugioh');
    expect(await runCli(['archive', 'circle:yugioh'], localDeps({ client: () => undefined }))).toBe(1);
    expect(err.at(-1)).toContain('OPENROUTER_API_KEY is not set');
    const nightly = takeDreamLease(memory, 'the nightly dream');
    if (!nightly.ok) throw new Error('lease');
    const { client, requests } = createCapturingClient([]);
    expect(await runCli(['archive', 'circle:yugioh'], localDeps({ client: () => client }))).toBe(1);
    nightly.lease.release();
    expect(requests).toHaveLength(0);
    expect(err.at(-1)).toContain('the nightly dream has been running since');
    expect(local.getCircle('yugioh')?.status).toBeNull();
    expect(await runCli(['archive'], localDeps())).toBe(2);
  });

  it('seeds circle activity from a file, idempotently, saying how each circle stands', async () => {
    const file = path.join(tmp, 'activity.json');
    local.writeCircles(
      [{ slug: 'tarkov', title: 'Tarkov', content: '## Now\nRaids.', members: [{ id: REMI }, { id: DALE }] }],
      { updatedBy: 'import' },
    );
    fs.writeFileSync(
      file,
      JSON.stringify({
        yugioh: { '2019-02': 30, '2020-02': 25, '2021-02': 12 },
        tarkov: { '2026-08': 40, '2026-09': 25 },
        nobody: { '2020-01': 1 },
      }),
    );
    expect(await runCli(['seed-activity', file, '--dry-run'], localDeps())).toBe(0);
    expect(local.activityOf(local.getCircle('yugioh')?.id ?? 0)).toEqual([]);
    expect(out).toContain('  - yugioh: 3 months (2019-02 → 2021-02), weight 67 → archived tonight (R 0.07) · yearly (usually Feb)');
    expect(out).toContain('  - tarkov: 2 months (2026-08 → 2026-09), weight 65 → present (R 0.91)');
    expect(out).toContain('warning: no circle nobody: skipped.');
    expect(out.at(-1)).toBe('Would seed 2 circles.');

    out.length = 0;
    expect(await runCli(['seed-activity', file], localDeps())).toBe(0);
    expect(await runCli(['seed-activity', file], localDeps())).toBe(0);
    expect(local.activityOf(local.getCircle('yugioh')?.id ?? 0)).toEqual([
      { month: '2019-02', weight: 30 },
      { month: '2020-02', weight: 25 },
      { month: '2021-02', weight: 12 },
    ]);

    // A malformed file seeds nothing.
    fs.writeFileSync(file, JSON.stringify({ yugioh: { March: 2 }, tarkov: { '2026-10': -1 } }));
    expect(await runCli(['seed-activity', file], localDeps())).toBe(1);
    expect(err).toContain('  - yugioh: "March" is not YYYY-MM');
    expect(err).toContain('  - tarkov 2026-10: the weight must be a whole number ≥ 0');
    fs.writeFileSync(file, JSON.stringify({ tarkov: { '2099-01': 3 } }));
    expect(await runCli(['seed-activity', file], localDeps())).toBe(1);
    expect(err).toContain('  - tarkov 2099-01: a month in the future');
    expect(local.activityOf(local.getCircle('tarkov')?.id ?? 0)).toHaveLength(2);
  });

  it('fails cleanly when another process keeps the database locked', async () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const locked = localDeps({
      openStores: () => {
        throw busy;
      },
    });
    expect(await runCli(['archive', 'yugioh'], locked)).toBe(1);
    expect(err.at(-1)).toMatch(/^failed: the database is busy .* Nothing was changed: run it again in a moment\.$/);
  });
});
