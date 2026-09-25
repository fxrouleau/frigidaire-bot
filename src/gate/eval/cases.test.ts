import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type GateEvalCase, caseToInput, loadCaseFile, loadCaseSources, passesPrefilter, validateCaseFile } from './cases';

const BUNDLED = path.join(__dirname, 'cases.json');
const NAMES = ['fridge', 'frigidaire', 'frigi', 'bot', 'clanker'];

const VALID_CASE = {
  id: 'ok-1',
  label: true,
  context: [
    { author: 'Kev', text: 'worlds draw is out' },
    { author: 'Frigidaire', bot: true, text: 'T1 again lol', replyTo: 'Kev' },
    { author: 'Hermes', otherBot: true, text: 'daily recap' },
  ],
  message: { author: 'Marco', text: 'fridge who wins worlds', replyTo: 'Theo' },
  botLastSpokeSecondsAgo: 30,
  talkingWithBot: false,
};

function file(...cases: unknown[]) {
  return { version: 1, cases };
}

const tmpDirs: string[] = [];

function writeTemp(name: string, content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cases-'));
  tmpDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content));
  return filePath;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the bundled eval set (src/gate/eval/cases.json)', () => {
  const cases = loadCaseFile(BUNDLED);

  it('is valid, large enough and balanced', () => {
    expect(cases.length).toBeGreaterThanOrEqual(80);
    const positives = cases.filter((c) => c.label).length;
    expect(positives).toBeGreaterThanOrEqual(30);
    expect(cases.length - positives).toBeGreaterThanOrEqual(30);
  });

  it('covers every kind of case the gate has to tell apart', () => {
    const count = (prefix: string, label: boolean) =>
      cases.filter((c) => c.id.startsWith(`${prefix}-`) && c.label === label).length;
    expect(count('name', true)).toBeGreaterThanOrEqual(10); // talking to it by name or nickname
    expect(count('followup', true)).toBeGreaterThanOrEqual(10); // continuing without a reply
    expect(count('about', false)).toBeGreaterThanOrEqual(10); // talking about it to others
    expect(count('fridge', false)).toBeGreaterThanOrEqual(5); // literal fridges
    expect(count('gaming', false)).toBeGreaterThanOrEqual(5); // bot lane, "plays like a bot"
    expect(count('reaction', false)).toBeGreaterThanOrEqual(5); // laughing at its last message
    expect(count('clanker', false)).toBeGreaterThanOrEqual(2); // clanker aimed at something else
  });

  it('uses every nickname in both senses somewhere', () => {
    for (const name of ['fridge', 'frigidaire', 'bot', 'clanker']) {
      const matcher = new RegExp(`\\b${name}\\b`, 'i');
      const withName = cases.filter((c) => matcher.test(c.message.text));
      expect(withName.some((c) => c.label), `${name} addressed`).toBe(true);
      expect(withName.some((c) => !c.label), `${name} not addressed`).toBe(true);
    }
  });

  it('has follow-up cases the live prefilter lets through', () => {
    const followups = cases.filter((c) => c.id.startsWith('followup-'));
    for (const c of followups) expect(passesPrefilter(c, NAMES, 120), c.id).toBe(true);
  });

  it('contains no Discord ids or links (it is committed to a public repo)', () => {
    const raw = fs.readFileSync(BUNDLED, 'utf8');
    expect(raw).not.toMatch(/\d{17,20}/);
    expect(raw).not.toMatch(/https?:\/\//);
  });
});

describe('validateCaseFile', () => {
  it('accepts a well-formed file', () => {
    const { cases, errors } = validateCaseFile(file(VALID_CASE), 'x.json');
    expect(errors).toEqual([]);
    expect(cases).toHaveLength(1);
  });

  it('rejects the wrong shape at the top level', () => {
    expect(validateCaseFile([], 'x.json').errors).toEqual(['x.json: the file must be a JSON object']);
    expect(validateCaseFile({ version: 2, cases: [] }, 'x.json').errors).toEqual(['x.json: "version" must be 1']);
    expect(validateCaseFile({ version: 1 }, 'x.json').errors).toEqual(['x.json: "cases" must be an array']);
  });

  it('lists every problem in a case, so a typo cannot silently change it', () => {
    const { cases, errors } = validateCaseFile(
      file(
        VALID_CASE,
        { ...VALID_CASE, labl: true },
        {
          ...VALID_CASE,
          id: 'bad-2',
          label: 'yes',
          context: [{ author: 'Kev', text: '', bot: true, otherBot: true }],
          message: { author: '', text: 'hi', replyTo: 3 },
          botLastSpokeSecondsAgo: -1,
          talkingWithBot: 'no',
        },
        { ...VALID_CASE, id: 'bad-3', context: 'none' },
      ),
      'x.json',
    );
    expect(cases).toEqual([]);
    expect(errors).toEqual([
      'x.json cases[1]: unknown field(s) labl',
      'x.json cases[1].id: duplicate id "ok-1"',
      'x.json cases[2].label: must be true or false',
      'x.json cases[2].context[0].text: must be a non-empty string',
      'x.json cases[2].context[0]: cannot be both bot and otherBot',
      'x.json cases[2].message.author: must be a non-empty string',
      'x.json cases[2].message.replyTo: must be a string',
      'x.json cases[2].botLastSpokeSecondsAgo: must be a number >= 0, or null',
      'x.json cases[2].talkingWithBot: must be a boolean',
      'x.json cases[3].context: must be an array (use [] for none)',
    ]);
  });

  it('does not allow context-only flags on the message itself', () => {
    const { errors } = validateCaseFile(
      file({ ...VALID_CASE, message: { author: 'Marco', text: 'hi', bot: true } }),
      'x.json',
    );
    expect(errors).toEqual(['x.json cases[0].message: unknown field(s) bot']);
  });
});

describe('loadCaseFile / loadCaseSources', () => {
  it('reads files in order and tags each case with its source', () => {
    const a = writeTemp('a.json', file(VALID_CASE));
    const b = writeTemp('gate-cases.json', file({ ...VALID_CASE, id: 'real-1', label: false }));
    const loaded = loadCaseSources([a, b]);
    expect(loaded.map((c) => [c.source, c.case.id])).toEqual([
      ['a.json', 'ok-1'],
      ['gate-cases.json', 'real-1'],
    ]);
  });

  it('rejects an id used in two files', () => {
    const a = writeTemp('a.json', file(VALID_CASE));
    const b = writeTemp('b.json', file(VALID_CASE));
    expect(() => loadCaseSources([a, b])).toThrow('Duplicate case id "ok-1" in b.json (also in a.json)');
  });

  it('explains unreadable or invalid files', () => {
    expect(() => loadCaseFile(writeTemp('broken.json', '{ nope'))).toThrow(/not readable JSON/);
    expect(() => loadCaseFile(writeTemp('invalid.json', file({ ...VALID_CASE, label: 1 })))).toThrow(
      /invalid:\n {2}.*label: must be true or false/,
    );
  });
});

describe('caseToInput', () => {
  it('builds exactly what the live gate sends', () => {
    const input = caseToInput(VALID_CASE as GateEvalCase, NAMES);
    expect(input).toEqual({
      botName: 'Frigidaire',
      nicknames: NAMES,
      message: { author: 'Marco', text: 'fridge who wins worlds', replyTo: 'Theo' },
      context: [
        { author: 'Kev', text: 'worlds draw is out' },
        { author: 'Frigidaire', kind: 'self', text: 'T1 again lol', replyTo: 'Kev' },
        { author: 'Hermes', kind: 'other_bot', text: 'daily recap' },
      ],
      secondsSinceBotSpoke: 30,
      authorIsBotsPartner: false,
    });
  });

  it('treats a null or missing botLastSpokeSecondsAgo as "not recently"', () => {
    const quiet = caseToInput({ ...(VALID_CASE as GateEvalCase), botLastSpokeSecondsAgo: null }, NAMES);
    expect(quiet.secondsSinceBotSpoke).toBeUndefined();
  });
});

describe('passesPrefilter', () => {
  const base = VALID_CASE as GateEvalCase;

  it('passes on a name, the bot name, or a recent follow-up from its partner', () => {
    expect(passesPrefilter(base, NAMES, 120)).toBe(true);
    expect(passesPrefilter({ ...base, message: { author: 'M', text: 'Frigidaire?' } }, [], 120)).toBe(true);
    const followup = { ...base, message: { author: 'M', text: 'why tho' }, talkingWithBot: true };
    expect(passesPrefilter(followup, NAMES, 120)).toBe(true);
    expect(passesPrefilter({ ...followup, botLastSpokeSecondsAgo: 200 }, NAMES, 120)).toBe(false);
    expect(passesPrefilter({ ...followup, talkingWithBot: false }, NAMES, 120)).toBe(false);
  });
});
