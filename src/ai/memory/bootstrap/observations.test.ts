import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { splitObservations, validateObservation, writeCastSheet } from './observations';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const KNOWN = new Set([REMI, DALE, NOVA]);

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-obs-'));
  fs.mkdirSync(path.join(work, 'observations'));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const obs = (overrides: Record<string, unknown> = {}) => ({
  people: [REMI],
  category: 'fact',
  kind: 'fact',
  content: 'Works at a bakery.',
  date: '2019-03-02',
  evidence: [{ chunk: '0001', lines: [10, 12] }],
  quote: 'the bakery shift starts at 5am',
  ...overrides,
});

function writeLog(file: string, lines: unknown[]): void {
  fs.writeFileSync(
    path.join(work, 'observations', file),
    `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`,
  );
}

function readLog(file: string): { content: string; date: string }[] {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('validateObservation', () => {
  it('accepts the documented shape', () => {
    const result = validateObservation(obs({ confidence: 0.8, circle: 'MTG' }), KNOWN);
    expect(result).toMatchObject({ ok: true, value: { people: [REMI], circle: 'mtg', confidence: 0.8 } });
  });

  it.each([
    ['no people', { people: [] }, '"people" must be a non-empty array'],
    ['group mixed with members', { people: ['group', REMI] }, 'either ["group"] or member ids'],
    ['an unknown id', { people: ['100000000000000999'] }, 'not a main id in people.json'],
    ['a name for an id', { people: ['Remi'] }, 'is not a Discord id'],
    ['an unknown kind', { kind: 'gossip' }, '"kind" must be one of'],
    ['an image category', { category: 'image' }, '"category" must be one of'],
    ['a bad date', { date: '03/02/2019' }, '"date" must be YYYY-MM or YYYY-MM-DD'],
    ['a year-only date', { date: '2019' }, '"date" must be YYYY-MM or YYYY-MM-DD'],
    ['no evidence', { evidence: [] }, '"evidence" must list at least one'],
    ['backwards lines', { evidence: [{ chunk: '0001', lines: [9, 3] }] }, 'with 1 ≤ from ≤ to'],
    ['a confidence out of range', { confidence: 2 }, '"confidence" must be a number from 0 to 1'],
    ['a bad circle slug', { circle: 'the mtg crew!' }, '"circle" must be a lowercase slug'],
  ])('refuses %s', (_label, overrides, message) => {
    const result = validateObservation(obs(overrides), KNOWN);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.some((e) => e.includes(message))).toBe(true);
  });
});

describe('splitObservations', () => {
  it("files each observation under everyone it involves, sorted by date, and indexes the logs", () => {
    writeLog('0002.jsonl', [
      obs({ content: 'Quit the bakery.', date: '2021-06' }),
      obs({
        people: [REMI, DALE],
        kind: 'relationship',
        content: 'Best friends since school.',
        date: '2019-03',
        circle: 'remi-and-dale',
      }),
    ]);
    writeLog('0001.jsonl', [obs(), obs({ people: ['group'], category: 'vibe', kind: 'joke', content: 'The calendar incident.' })]);

    const result = splitObservations(work, KNOWN);

    expect(result).toMatchObject({ observations: 4, files: 2, errors: [] });
    expect(readLog(path.join(work, 'by-person', `${REMI}.jsonl`)).map((o) => o.content)).toEqual([
      'Best friends since school.',
      'Works at a bakery.',
      'Quit the bakery.',
    ]);
    expect(readLog(path.join(work, 'by-person', `${DALE}.jsonl`)).map((o) => o.content)).toEqual([
      'Best friends since school.',
    ]);
    expect(readLog(path.join(work, 'by-person', 'group.jsonl'))).toHaveLength(1);
    expect(readLog(path.join(work, 'by-circle', 'remi-and-dale.jsonl'))).toHaveLength(1);
    const index = JSON.parse(fs.readFileSync(path.join(work, 'by-person', 'index.json'), 'utf8'));
    expect(index.people[0]).toMatchObject({ owner: REMI, observations: 3, first: '2019-03', last: '2021-06' });
    expect(index.people[0].tokens).toBeGreaterThan(0);
    expect(Object.keys(index.people[0].years)).toEqual(['2019', '2021']);
    expect(index.group).toMatchObject({ owner: 'group', observations: 1 });
  });

  it('reports bad lines with their place and leaves them out, never touching the log', () => {
    writeLog('0001.jsonl', [obs(), '{not json', obs({ kind: 'gossip' })]);
    const before = fs.readFileSync(path.join(work, 'observations', '0001.jsonl'), 'utf8');
    const result = splitObservations(work, KNOWN);
    expect(result.observations).toBe(1);
    expect(result.errors).toEqual([
      'observations/0001.jsonl:2: not valid JSON',
      'observations/0001.jsonl:3: "kind" must be one of trait, fact, event, joke, relationship, history',
    ]);
    expect(fs.readFileSync(path.join(work, 'observations', '0001.jsonl'), 'utf8')).toBe(before);
  });

  it('rebuilds the views from scratch every time', () => {
    writeLog('0001.jsonl', [obs()]);
    splitObservations(work, KNOWN);
    writeLog('0001.jsonl', [obs({ people: [NOVA] })]);
    splitObservations(work, KNOWN);
    expect(fs.existsSync(path.join(work, 'by-person', `${REMI}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(work, 'by-person', `${NOVA}.jsonl`))).toBe(true);
  });

  it('handles a work folder with no observations yet', () => {
    fs.rmSync(path.join(work, 'observations'), { recursive: true });
    expect(splitObservations(work)).toMatchObject({ observations: 0, files: 0, people: [], circles: [] });
  });
});

describe('writeCastSheet', () => {
  it("lists every working profile's first paragraph", () => {
    const write = (id: string, text: string) => {
      fs.mkdirSync(path.join(work, 'working', 'people', id), { recursive: true });
      fs.writeFileSync(path.join(work, 'working', 'people', id, 'profile.md'), text);
    };
    write(REMI, "---\ntitle: Remi\n---\nRemi, the group's night owl.\nRuns the drafts.\n\n## Now\nBakes.");
    write(DALE, '---\ntitle: Dale\n---\n## Now\nDrives everyone home.');
    fs.mkdirSync(path.join(work, 'working', 'people', NOVA), { recursive: true });
    expect(writeCastSheet(work)).toBe(2);
    expect(fs.readFileSync(path.join(work, 'cast.md'), 'utf8').split('\n').slice(2, 4)).toEqual([
      `- Remi (id:${REMI}): Remi, the group's night owl. Runs the drafts.`,
      `- Dale (id:${DALE}): Drives everyone home.`,
    ]);
  });
});
