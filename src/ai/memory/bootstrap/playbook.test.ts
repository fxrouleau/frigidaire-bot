// The Claude Code playbook (.claude/skills/memory-bootstrap/SKILL.md) shows the formats its subagents
// write: its examples must pass the very validators the import and the observations helper run, or a
// subagent following them to the letter would produce a tree the bot refuses. The skill isn't in the
// Docker build context (.dockerignore), so this only runs in a checkout.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkNotesTree } from './importer';
import { validateObservation } from './observations';

const SKILL = path.join(process.cwd(), '.claude', 'skills', 'memory-bootstrap', 'SKILL.md');
const present = fs.existsSync(SKILL);

// The placeholder ids the playbook uses.
const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';

/** Every fenced block of a language, in order. */
function blocks(markdown: string, lang: string): string[] {
  const found: string[] = [];
  const fence = new RegExp(`^( *)\`\`\`${lang}\\n([\\s\\S]*?)^\\1\`\`\``, 'gm');
  for (const match of markdown.matchAll(fence)) {
    const indent = match[1].length;
    found.push(
      match[2]
        .split('\n')
        .map((line) => line.slice(indent))
        .join('\n'),
    );
  }
  return found;
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-playbook-'));
  vi.stubEnv('LINKED_ACCOUNTS', '');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe.skipIf(!present)('the memory bootstrap playbook', () => {
  const skill = present ? fs.readFileSync(SKILL, 'utf8') : '';

  it('has the front matter Claude Code needs to load it as a skill', () => {
    expect(skill.startsWith('---\nname: memory-bootstrap\ndescription: ')).toBe(true);
  });

  it('shows observation lines the observations helper accepts', () => {
    const lines = blocks(skill, 'json')
      .flatMap((block) => block.split('\n'))
      .filter((line) => line.startsWith('{"people"'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(validateObservation(JSON.parse(line), new Set([REMI, DALE, NOVA]))).toMatchObject({ ok: true });
    }
  });

  it('shows a profile, a circle and a manifest the import accepts', () => {
    const markdown = blocks(skill, 'markdown');
    const profile = markdown.find((b) => b.startsWith('---\ntitle: Remi\n'));
    const circle = markdown.find((b) => b.startsWith('---\ntitle: The MTG crew\n'));
    const manifest = blocks(skill, 'json').find((b) => b.includes('"format": "frigidaire-notes"'));
    expect(profile && circle && manifest).toBeTruthy();

    const dir = path.join(tmp, 'final');
    fs.mkdirSync(path.join(dir, 'people', REMI), { recursive: true });
    fs.mkdirSync(path.join(dir, 'circles'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), manifest ?? '');
    fs.writeFileSync(path.join(dir, 'people', REMI, 'profile.md'), profile ?? '');
    fs.writeFileSync(path.join(dir, 'circles', 'mtg.md'), circle ?? '');

    const known = {
      names: new Map([
        [REMI, 'Remi'],
        [DALE, 'Dale'],
        [NOVA, 'Nova'],
      ]),
      sides: new Map<string, string>(),
      source: 'the playbook test',
    };
    const result = checkNotesTree(dir, known);
    expect(result.errors).toEqual([]);
    expect(result.load).toMatchObject({ ok: true, summary: { people: 1, circles: 1 } });
  });
});
