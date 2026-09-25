import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCENARIOS_PATH,
  ScenarioFileError,
  castMember,
  loadScenarioFile,
  parseScenarioFile,
  selectScenarios,
} from './scenarioFile';

// A minimal valid file; each negative test breaks exactly one thing in a copy of it.
function validFile() {
  return {
    version: 1,
    bot: { name: 'Frigidaire', id: '900000000000000001' },
    cast: [
      { name: 'Ana', id: '100000000000000001', aliases: ['agathe'] },
      { name: 'Bo', id: '100000000000000002', username: 'bobo' },
    ],
    emojis: [{ id: '200000000000000001', name: 'KEKW', caption: 'laughing' }],
    sharedMemories: [{ category: 'vibe', subject: 'server', content: 'They roast each other constantly.' }],
    scenarios: [
      {
        id: 'first-one',
        title: 'First',
        tags: ['roast'],
        memories: [{ category: 'fact', subject: 'Bo', content: 'Bo mains Yasuo.' }],
        history: [{ author: 'Bo', content: 'gg <:KEKW:200000000000000001>', minutesAgo: 3 }],
        message: { author: 'Ana', content: '<@bot> roast <@Bo>' },
        expectations: { notes: 'A real roast.', maxSentences: 3, mustNotMatch: ['just kidding'] },
      },
    ],
  };
}

type Mutable = ReturnType<typeof validFile> & Record<string, unknown>;

function expectInvalid(mutate: (file: Mutable) => void, fieldPath: string): void {
  const file = validFile() as Mutable;
  mutate(file);
  expect(() => parseScenarioFile(file)).toThrow(ScenarioFileError);
  expect(() => parseScenarioFile(file)).toThrow(fieldPath);
}

describe('the committed scenarios.json', () => {
  const file = loadScenarioFile(DEFAULT_SCENARIOS_PATH);

  it('loads and has at least 15 scenarios', () => {
    expect(file.scenarios.length).toBeGreaterThanOrEqual(15);
  });

  it('covers every situation the harness is meant to probe', () => {
    const tags = new Set(file.scenarios.flatMap((s) => s.tags));
    for (const tag of [
      'roast',
      'help',
      'meme',
      'correction',
      'emoji',
      'detail',
      'distress',
      'memory-negative',
      'memory-positive',
      'web',
    ]) {
      expect(tags, `no scenario tagged "${tag}"`).toContain(tag);
    }
  });

  it('gives the bot a non-member id and every person a unique snowflake', () => {
    const ids = file.cast.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(file.bot.id);
  });

  it('uses placeholder ids only, never a real Discord id (the repo is public)', () => {
    const placeholder = /^[1-9]0{12,}\d{1,3}$/;
    const ids = [file.bot.id, ...file.cast.map((c) => c.id), ...file.emojis.map((e) => e.id)];
    for (const id of ids) expect(id).toMatch(placeholder);
  });
});

describe('parseScenarioFile', () => {
  it('fills defaults: username from the name, one allowed custom emoji, empty regex lists', () => {
    const parsed = parseScenarioFile(validFile());
    expect(parsed.cast[0]).toMatchObject({ name: 'Ana', username: 'ana', aliases: ['agathe'] });
    expect(parsed.cast[1].username).toBe('bobo');
    const [scenario] = parsed.scenarios;
    expect(scenario.expectations).toMatchObject({ maxCustomEmojis: 1, mustMatch: [], mustNotMatch: ['just kidding'] });
    expect(scenario.message).toEqual({ author: 'Ana', content: '<@bot> roast <@Bo>', embeds: [] });
    expect(scenario.history[0]).toMatchObject({ author: 'Bo', minutesAgo: 3, embeds: [] });
  });

  it('accepts a message that is only an embed (a posted meme)', () => {
    const file = validFile() as Mutable;
    file.scenarios[0].history = [
      { author: 'Bo', content: '', minutesAgo: 2, embeds: [{ title: 'meme' }] } as never,
    ];
    expect(parseScenarioFile(file).scenarios[0].history[0].embeds).toEqual([
      { title: 'meme', description: undefined, url: undefined, imageUrl: undefined },
    ]);
  });

  it('rejects an unsupported version', () => {
    expectInvalid((f) => {
      f.version = 2 as never;
    }, 'version');
  });

  it('rejects a cast id that is not a snowflake, and duplicate names', () => {
    expectInvalid((f) => {
      f.cast[0].id = '42';
    }, 'cast[0].id');
    expectInvalid((f) => {
      f.cast[1].name = 'ana';
    }, 'cast[1].name');
  });

  it('reserves "bot" as an author name', () => {
    expectInvalid((f) => {
      f.cast[0].name = 'bot';
    }, 'cast[0].name');
  });

  it('rejects memories about unknown subjects or in categories the bot cannot write', () => {
    expectInvalid((f) => {
      f.scenarios[0].memories[0].subject = 'Nobody';
    }, 'scenarios[0].memories[0].subject');
    expectInvalid((f) => {
      f.scenarios[0].memories[0].category = 'capability_gap';
    }, 'scenarios[0].memories[0].category');
  });

  it('rejects mentions of unknown people and raw-id mentions', () => {
    expectInvalid((f) => {
      f.scenarios[0].message.content = '<@bot> roast <@Zed>';
    }, 'scenarios[0].message.content');
    expectInvalid((f) => {
      f.scenarios[0].message.content = '<@bot> roast <@100000000000000002>';
    }, 'scenarios[0].message.content');
  });

  it('rejects a custom emoji whose id is not in the emoji list (a typo would test nothing)', () => {
    expectInvalid((f) => {
      f.scenarios[0].history[0].content = 'gg <:KEKW:200000000000000009>';
    }, 'scenarios[0].history[0].content');
  });

  it('rejects history without a positive age, and a triggering message from the bot', () => {
    expectInvalid((f) => {
      f.scenarios[0].history[0].minutesAgo = 0;
    }, 'scenarios[0].history[0].minutesAgo');
    expectInvalid((f) => {
      f.scenarios[0].message.author = 'bot';
    }, 'scenarios[0].message.author');
  });

  it('rejects invalid regexes and contradictory length bounds', () => {
    expectInvalid((f) => {
      f.scenarios[0].expectations.mustNotMatch = ['(unclosed'];
    }, 'scenarios[0].expectations.mustNotMatch[0]');
    expectInvalid((f) => {
      Object.assign(f.scenarios[0].expectations, { minChars: 500, maxChars: 100 });
    }, 'minChars is larger than maxChars');
  });

  it('rejects duplicate or non-kebab scenario ids and an empty scenario list', () => {
    expectInvalid((f) => {
      f.scenarios.push({ ...f.scenarios[0] });
    }, 'duplicate scenario id');
    expectInvalid((f) => {
      f.scenarios[0].id = 'Not Kebab';
    }, 'scenarios[0].id');
    expectInvalid((f) => {
      f.scenarios = [];
    }, 'at least one scenario');
  });
});

describe('loadScenarioFile', () => {
  it('names the file when it cannot be read or parsed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-eval-'));
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{ not json');
    try {
      expect(() => loadScenarioFile(broken)).toThrow(`${broken}: cannot read scenarios`);
      expect(() => loadScenarioFile(path.join(dir, 'missing.json'))).toThrow(ScenarioFileError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('selectScenarios / castMember', () => {
  const file = parseScenarioFile({
    ...validFile(),
    scenarios: [
      { ...validFile().scenarios[0], id: 'a' },
      { ...validFile().scenarios[0], id: 'b' },
    ],
  });

  it('returns everything for no ids, or the requested ones in the requested order', () => {
    expect(selectScenarios(file, []).map((s) => s.id)).toEqual(['a', 'b']);
    expect(selectScenarios(file, ['b', 'a']).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('fails loudly on an unknown id instead of silently running less', () => {
    expect(() => selectScenarios(file, ['a', 'nope'])).toThrow('unknown scenario id(s): nope');
  });

  it('finds cast members case-insensitively', () => {
    expect(castMember(file, 'BO')?.id).toBe('100000000000000002');
    expect(castMember(file, 'nobody')).toBeUndefined();
  });
});
