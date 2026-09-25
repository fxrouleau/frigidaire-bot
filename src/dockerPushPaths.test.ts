// docker-push.yml only builds and deploys a master push that touches one of its `paths`. Every file a
// Dockerfile copies by name is an input of its image, so a change to that file alone must trigger a deploy
// too: .yarnrc.yml once didn't, so an install setting change would have waited for an unrelated src/ change.
// The workflow isn't in the Docker build context (.dockerignore), so this only runs in a checkout.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'docker-push.yml');
const present = fs.existsSync(WORKFLOW);
const inCheckout = fs.existsSync(path.join(ROOT, '.git'));

/** The entries of the first `paths:` list (on.push.paths), e.g. ['Dockerfile', 'src/**']. */
function triggerPaths(workflow: string): string[] {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => /^\s+paths:\s*$/.test(line));
  const entries: string[] = [];
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    const match = /^\s+-\s+'?([^'\s]+)'?\s*$/.exec(line);
    if (!match) break;
    entries.push(match[1]);
  }
  return entries;
}

/** GitHub's path filter globs, as far as this workflow uses them: `**` crosses directories, `*` doesn't. */
function globToRegExp(glob: string): RegExp {
  const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const pattern = glob
    .split('**')
    .map((part) => part.split('*').map(escape).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${pattern}$`);
}

/** Build-context files a Dockerfile COPYs by name (not `--from` another stage; `.` is the whole context). */
function copiedFiles(dockerfile: string, context: string): string[] {
  return dockerfile
    .split('\n')
    .filter((line) => /^COPY\s/.test(line) && !line.includes('--from='))
    .flatMap((line) => {
      const args = line
        .trim()
        .split(/\s+/)
        .slice(1)
        .filter((arg) => !arg.startsWith('--'));
      return args.slice(0, -1);
    })
    .filter((source) => source !== '.')
    .map((source) => path.posix.join(context, source));
}

describe.skipIf(!present && !inCheckout)('docker-push.yml trigger paths', () => {
  it('cover both Dockerfiles and every file they copy by name', () => {
    const patterns = triggerPaths(present ? fs.readFileSync(WORKFLOW, 'utf8') : '').map(globToRegExp);
    const inputs = [
      'Dockerfile',
      'sandbox/Dockerfile',
      ...copiedFiles(fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8'), ''),
      ...copiedFiles(fs.readFileSync(path.join(ROOT, 'sandbox', 'Dockerfile'), 'utf8'), 'sandbox'),
    ];

    expect(inputs).toEqual(
      expect.arrayContaining(['package.json', 'yarn.lock', '.yarnrc.yml', 'docker/entrypoint.sh', 'sandbox/server.py']),
    );
    expect(inputs.filter((input) => !patterns.some((pattern) => pattern.test(input)))).toEqual([]);
  });
});
