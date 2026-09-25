import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// Entry points and the relative path each one uses for ./loadEnv.
const ENTRY_POINTS: Array<[file: string, specifier: string]> = [
  ['app.ts', './loadEnv'],
  ['evals/persona/cli.ts', '../../loadEnv'],
  ['gate/eval/runEval.ts', '../../loadEnv'],
];

function importLines(file: string): string[] {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  return source.split('\n').filter((line) => line.startsWith('import '));
}

describe('.env loading order', () => {
  it.each(ENTRY_POINTS)('%s imports loadEnv before anything else (modules read config while loading)', (file, spec) => {
    expect(importLines(file)[0]).toBe(`import '${spec}';`);
  });

  it('is the only place dotenv is loaded, so no entry point calls it after its imports ran', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entry.name !== 'loadEnv.ts') {
          if (/from 'dotenv'|require\('dotenv'\)|import 'dotenv/.test(fs.readFileSync(full, 'utf8'))) {
            offenders.push(path.relative(__dirname, full));
          }
        }
      }
    };
    walk(__dirname);
    expect(offenders).toEqual([]);
  });
});
