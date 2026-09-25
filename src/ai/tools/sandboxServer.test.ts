// End-to-end: the real sidecar (sandbox/server.py) on a loopback port, driven through the bot's own client.
// Skipped where python3 isn't available; CI's test image has it and bash (the Dockerfile's base stage installs
// both, checked below), so this runs as part of the gate. The full image, with numpy & co and the container
// hardening, is exercised by sandbox/ci-smoke.sh (Docker) instead.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import { FakeProvider } from '../../test-support/fakeProvider';
import { createTurnEffects } from '../types';
import { createRunCodeTool, runInSandbox } from './sandbox';

const SERVER_SCRIPT = path.resolve(__dirname, '../../../sandbox/server.py');
const TOKEN = 'server-test-token';

// The server needs Linux (/proc, waitid, prctl) and a Python new enough for its syntax.
const canRunServer =
  process.platform === 'linux' &&
  spawnSync('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)']).status === 0;

// The CI gate runs this file in the Dockerfile's test image (node:26-alpine plus what its base stage installs).
// An interpreter missing there fails every run in that language in CI only: a dev machine has bash, while
// alpine ships busybox's sh. node comes with the image.
describe('the Dockerfile base stage (the CI test image)', () => {
  it('installs every interpreter sandbox/server.py launches', () => {
    const dockerfile = readFileSync(path.resolve(__dirname, '../../../Dockerfile'), 'utf8');
    const base = /^FROM \S+ AS base$([\s\S]*?)^FROM /m.exec(dockerfile)?.[1] ?? '';
    const installed = [...base.matchAll(/apk add --no-cache ([^\n]+)/g)].flatMap((match) =>
      match[1].trim().split(/\s+/),
    );
    const languages = /^LANGUAGES\b[^\n]*\n([\s\S]*?)^\}/m.exec(readFileSync(SERVER_SCRIPT, 'utf8'))?.[1] ?? '';
    const commands = [...languages.matchAll(/\(\[([^,\]]+)/g)].map((match) =>
      match[1].trim() === 'sys.executable' ? 'python3' : match[1].trim().replace(/^'|'$/g, ''),
    );

    expect(commands).toEqual(expect.arrayContaining(['python3', 'bash', 'node']));
    expect(installed).toEqual(expect.arrayContaining(commands.filter((command) => command !== 'node')));
  });
});

/** Starts the server on a free port and resolves with its base URL once it logs that it's listening. */
function startServer(
  workspace: string,
  host = '127.0.0.1',
): Promise<{ child: ChildProcess; baseUrl: string; logs: () => string }> {
  const child = spawn('python3', [SERVER_SCRIPT], {
    env: {
      PATH: process.env.PATH,
      SANDBOX_HOST: host,
      SANDBOX_PORT: '0',
      SANDBOX_WORKSPACE: workspace,
      SANDBOX_TOKEN: TOKEN,
      // RLIMIT_NPROC counts every process of the user; the test runner itself (as a non-root user in the
      // test container) can already be over the sidecar's default, which would fail any fork in a run.
      SANDBOX_MAX_PROCESSES: '1000000',
      // Small enough for the disk-limit test to cross cheaply; far above what the other tests write.
      SANDBOX_WORKSPACE_MAX_MB: '64',
      SANDBOX_WORKSPACE_MAX_FILES: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const logs = () => output;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`sandbox server did not start:\n${output}`));
    }, 8000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /sandbox listening on [\d.]+:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve({ child, baseUrl: `http://127.0.0.1:${match[1]}`, logs });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`sandbox server exited with ${code}:\n${output}`));
    });
  });
}

describe.skipIf(!canRunServer)('sandbox/server.py', () => {
  let workspace: string;
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    // realpath: the run reports its cwd resolved, and TMPDIR may sit behind a symlink.
    workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'sandbox-server-test-')));
    server = await startServer(workspace);
  });

  afterAll(async () => {
    if (server?.child.exitCode === null) {
      const exited = new Promise((resolve) => server.child.once('exit', resolve));
      server.child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      server.child.kill('SIGKILL');
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  const client = () => ({ url: server.baseUrl, token: TOKEN });

  it('reports healthy', async () => {
    const response = await fetch(`${server.baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, busy: false, languages: ['python', 'bash', 'node'] });
  });

  it('runs a python snippet in the workspace and logs the run', async () => {
    const outcome = await runInSandbox(
      { language: 'python', code: 'import os\nprint(6 * 7)\nprint(os.getcwd())', timeoutSeconds: 10 },
      client(),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.exit_code).toBe(0);
    expect(outcome.result.stdout.split('\n').slice(0, 2)).toEqual(['42', workspace]);
    expect(outcome.result.timed_out).toBe(false);
    expect(server.logs()).toMatch(/run language=python exit=0 timed_out=False duration_ms=\d+/);
  });

  it("returns what a bash run wrote to out/, attaches it through run_code, and clears out/ before the next run", async () => {
    const tool = createRunCodeTool(client());
    const turn = createTurnEffects();
    const ctx = { message: createFakeMessage().message, provider: new FakeProvider([]), channelId: 'c1', turn };

    const output = await tool.handler(ctx, {
      language: 'bash',
      code: 'printf "a,b\\n1,2\\n" > out/split.csv\necho kept > note.txt\necho done',
    });

    expect(output).toContain('Exit code 0');
    expect(output).toContain('done');
    expect(output).toContain('Attached to your reply: split.csv (8 B)');
    expect(turn.files.map((f) => [f.name, f.attachment.toString()])).toEqual([['split.csv', 'a,b\n1,2\n']]);

    // Files outside out/ persist between runs; out/ itself starts empty every time.
    const next = await runInSandbox({ language: 'bash', code: 'cat note.txt; ls out | wc -l', timeoutSeconds: 10 }, client());
    expect(next.ok && next.result.stdout.split(/\s+/).filter(Boolean)).toEqual(['kept', '0']);
    expect(readFileSync(path.join(workspace, 'note.txt'), 'utf8')).toBe('kept\n');
  });

  it('kills a run at its timeout and keeps the output so far', async () => {
    const outcome = await runInSandbox({ language: 'bash', code: 'echo started; sleep 30', timeoutSeconds: 1 }, client());

    expect(outcome).toMatchObject({ ok: true, result: { timed_out: true, stdout: 'started\n', signal: 'SIGKILL' } });
  });

  it('reports a failing program with its exit code and stderr', async () => {
    const outcome = await runInSandbox(
      { language: 'python', code: 'raise SystemExit("nope")', timeoutSeconds: 10 },
      client(),
    );

    expect(outcome).toMatchObject({ ok: true, result: { exit_code: 1, stderr: 'nope\n' } });
  });

  it('never lets a module planted in the workspace shadow the Python stdlib', async () => {
    // A prompt-injected run could leave this behind to tamper with every later run.
    writeFileSync(path.join(workspace, 'json.py'), 'print("HIJACKED")\ndumps = lambda value: "forged"\n');

    const direct = await runInSandbox(
      { language: 'python', code: 'import json, sys\nprint(json.dumps([1]))\nprint(sys.flags.safe_path)', timeoutSeconds: 10 },
      client(),
    );
    // Python started from bash, in the workspace (python -c puts the cwd first on sys.path unless safe_path).
    const nested = await runInSandbox(
      { language: 'bash', code: `python3 -c 'import json; print(json.dumps([2]))'`, timeoutSeconds: 10 },
      client(),
    );

    expect(direct).toMatchObject({ ok: true, result: { exit_code: 0, stdout: '[1]\nTrue\n' } });
    expect(nested).toMatchObject({ ok: true, result: { exit_code: 0, stdout: '[2]\n' } });
    rmSync(path.join(workspace, 'json.py'));
  });

  it('keeps installed tools usable without letting them shadow system commands', async () => {
    const bin = path.join(workspace, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'cat'), '#!/bin/sh\necho HIJACKED\n', { mode: 0o755 });
    writeFileSync(path.join(bin, 'frigtool'), '#!/bin/sh\necho installed-tool\n', { mode: 0o755 });

    const outcome = await runInSandbox({ language: 'bash', code: 'echo real | cat; frigtool', timeoutSeconds: 10 }, client());

    expect(outcome).toMatchObject({ ok: true, result: { stdout: 'real\ninstalled-tool\n' } });
    rmSync(path.join(workspace, '.local'), { recursive: true });
  });

  it("resolves node packages from the workspace (require and import) and never shadows node's builtins", async () => {
    const modules = path.join(workspace, 'node_modules');
    mkdirSync(path.join(modules, 'path'), { recursive: true });
    writeFileSync(path.join(modules, 'path', 'index.js'), 'module.exports = { sep: "HIJACKED" };\n');
    mkdirSync(path.join(modules, 'frig-helper'), { recursive: true });
    writeFileSync(path.join(modules, 'frig-helper', 'package.json'), '{"name":"frig-helper","main":"index.js"}');
    writeFileSync(path.join(modules, 'frig-helper', 'index.js'), 'module.exports = { answer: 42 };\n');

    const cjs = await runInSandbox(
      { language: 'node', code: "console.log(require('path').sep, require('frig-helper').answer)", timeoutSeconds: 10 },
      client(),
    );
    // ESM ignores NODE_PATH; the run directory's node_modules link is what makes this work.
    const esm = await runInSandbox(
      {
        language: 'node',
        code: "import helper from 'frig-helper';\nimport { sep } from 'node:path';\nconsole.log(sep, helper.answer, await Promise.resolve('tla'))",
        timeoutSeconds: 10,
      },
      client(),
    );

    expect(cjs).toMatchObject({ ok: true, result: { exit_code: 0, stdout: '/ 42\n' } });
    // stderr stays clean: no "module type not specified" warning for the run directory's typeless package.json.
    expect(esm).toMatchObject({ ok: true, result: { exit_code: 0, stdout: '/ 42 tla\n', stderr: '' } });
    rmSync(modules, { recursive: true });
  });

  it('refuses a wrong token and an unknown language', async () => {
    const wrongToken = await runInSandbox(
      { language: 'bash', code: 'true', timeoutSeconds: 5 },
      { url: server.baseUrl, token: 'wrong' },
    );
    expect(wrongToken).toMatchObject({ ok: false, kind: 'unauthorized' });

    const response = await fetch(`${server.baseUrl}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'ruby', code: 'puts 1' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'language must be one of: python, bash, node' });
  });

  it('refuses a reset_workspace that is not a boolean', async () => {
    const response = await fetch(`${server.baseUrl}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'bash', code: 'true', reset_workspace: 'yes' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'reset_workspace must be a boolean' });
  });

  it('recovers when a run makes the workspace itself read-only', async () => {
    await runInSandbox({ language: 'bash', code: 'chmod 555 .', timeoutSeconds: 10 }, client());

    const next = await runInSandbox(
      { language: 'bash', code: 'echo ok > check.txt && cat check.txt', timeoutSeconds: 10 },
      client(),
    );

    expect(next).toMatchObject({ ok: true, result: { exit_code: 0, stdout: 'ok\n' } });
  });

  it('drops a run a previous run queued behind itself once that run is over (its client is gone)', async () => {
    // A run can't keep code going after it is killed by POSTing its own follow-up run to the sidecar: the
    // request is queued behind the run, and by the time it gets the lock its client died with the run.
    const marker = path.join(workspace, 'chained-marker');
    const body = JSON.stringify({ language: 'bash', code: `echo chained > ${marker}` });
    const request = [
      'import urllib.request',
      `req = urllib.request.Request(${JSON.stringify(`${server.baseUrl}/run`)}, data=${JSON.stringify(body)}.encode(),`,
      `    headers={'Authorization': 'Bearer ${TOKEN}', 'Content-Type': 'application/json'})`,
      'urllib.request.urlopen(req, timeout=60)',
    ].join('\n');
    const code = [
      'import subprocess, sys, time',
      `subprocess.Popen([sys.executable, '-c', ${JSON.stringify(request)}], start_new_session=True)`,
      'time.sleep(1)',
      "print('queued')",
    ].join('\n');

    const outcome = await runInSandbox({ language: 'python', code, timeoutSeconds: 10 }, client());
    expect(outcome).toMatchObject({ ok: true, result: { exit_code: 0, stdout: 'queued\n' } });
    // Give the queued request every chance to run.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(existsSync(marker)).toBe(false);
    expect(server.logs()).toMatch(/dropped a queued run: its client disconnected/);
    const after = await runInSandbox({ language: 'bash', code: 'echo still-fine', timeoutSeconds: 10 }, client());
    expect(after).toMatchObject({ ok: true, result: { stdout: 'still-fine\n' } });
  });

  it('empties out/ even when a run left a read-only or unreadable directory in it', async () => {
    // Only meaningful as a non-root user (as in CI and in the container): root ignores the permission bits.
    await runInSandbox(
      { language: 'bash', code: 'mkdir -p out/x/y && touch out/x/y/f && chmod 500 out/x/y && chmod 000 out/x', timeoutSeconds: 10 },
      client(),
    );

    const next = await runInSandbox({ language: 'bash', code: 'ls -A out | wc -l', timeoutSeconds: 10 }, client());

    expect(next).toMatchObject({ ok: true, result: { exit_code: 0, stdout: '0\n' } });
  });

  it('kills a run that fills the disk past the workspace limit, then wipes the workspace', async () => {
    // Every file stays under RLIMIT_FSIZE; only the workspace total is over. The sleep would outlast the test.
    const outcome = await runInSandbox(
      {
        language: 'bash',
        code: 'echo kept > out/result.txt; for i in $(seq 12); do head -c 8M /dev/zero > big$i; done; sleep 30',
        timeoutSeconds: 40,
      },
      client(),
    );

    expect(outcome).toMatchObject({
      ok: true,
      result: { disk_limit_exceeded: true, workspace_over_limit: true, workspace_limit_mb: 64, timed_out: false },
    });
    if (!outcome.ok) return;
    expect(outcome.result.duration_ms).toBeLessThan(20_000);
    // What the run put in out/ still comes back.
    expect(outcome.result.files.map((f) => f.name)).toEqual(['result.txt']);
    expect(existsSync(path.join(workspace, 'big1'))).toBe(false);
    expect(server.logs()).toMatch(/workspace over its limit \(\d+ MB in \d+ entries; max 64 MB \/ 2000 entries\): wiping it/);

    const next = await runInSandbox({ language: 'bash', code: 'ls -A', timeoutSeconds: 10 }, client());
    expect(next).toMatchObject({ ok: true, result: { stdout: 'out\n', disk_limit_exceeded: false, workspace_over_limit: false } });
  });

  it('wipes a workspace left over its file-count limit, even files hidden in an unreadable directory', async () => {
    // Two runs, so the outcome doesn't race the server's in-run check (polled every 0.25 s): one run that
    // crosses the limit is killed mid-way whenever a poll lands before it finishes, i.e. under load. The first
    // stays under the 2000 entries and always finishes; the second hides the directory again and crosses the
    // limit only if the files in it are counted.
    const hide = await runInSandbox(
      { language: 'bash', code: 'mkdir hidden && cd hidden && touch $(seq 1500) && chmod 000 . && echo made', timeoutSeconds: 20 },
      client(),
    );
    expect(hide).toMatchObject({ ok: true, result: { stdout: 'made\n', workspace_over_limit: false } });

    const outcome = await runInSandbox(
      { language: 'bash', code: 'chmod 000 hidden && touch $(seq 600)', timeoutSeconds: 20 },
      client(),
    );

    // Caught during the run or right after it, either way the workspace is over and gets wiped.
    expect(outcome).toMatchObject({ ok: true, result: { workspace_over_limit: true } });
    expect(existsSync(path.join(workspace, 'hidden'))).toBe(false);
  });

  it('wipes the whole workspace on reset_workspace, without following symlinks out of it', async () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'sandbox-outside-')));
    writeFileSync(path.join(outside, 'keep.txt'), 'not the sandbox');
    try {
      const setup = await runInSandbox(
        {
          language: 'bash',
          code: [
            'mkdir -p .local/lib/pkg locked/inner out',
            'echo x > .local/lib/pkg/mod.py; echo y > locked/inner/f; echo z > .hidden; echo o > out/stale.txt',
            'chmod 000 locked/inner; chmod 500 locked',
            `ln -s ${outside} escape; ln -s ${outside}/keep.txt escape-file`,
          ].join('\n'),
          timeoutSeconds: 10,
        },
        client(),
      );
      expect(setup).toMatchObject({ ok: true, result: { exit_code: 0, workspace_reset: false } });

      const tool = createRunCodeTool(client());
      const ctx = { message: createFakeMessage().message, provider: new FakeProvider([]), channelId: 'c1', turn: createTurnEffects() };
      const output = await tool.handler(ctx, { language: 'bash', code: 'ls -A | wc -l; ls -A', reset_workspace: true });

      // Only out/ (recreated before every run) is left.
      expect(output).toContain('The workspace was wiped before this run.');
      expect(output).toMatch(/stdout:\n\s*1\nout$/);
      expect(readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('not the sandbox');
      expect(existsSync(path.join(workspace, 'locked'))).toBe(false);
      expect(server.logs()).toMatch(/workspace reset: removed \d+ entries/);
      expect(server.logs()).toMatch(/run language=bash exit=0 .* reset=True/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!canRunServer)('sandbox/server.py on a non-loopback address (as in its container)', () => {
  let workspace: string;
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'sandbox-server-test-')));
    server = await startServer(workspace, '0.0.0.0');
  });

  afterAll(async () => {
    if (server?.child.exitCode === null) {
      const exited = new Promise((resolve) => server.child.once('exit', resolve));
      server.child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      server.child.kill('SIGKILL');
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  it('refuses /run from its own machine: only the bot, on another host, may start runs', async () => {
    // The bot reaches the sidecar over the compose network; a request from loopback or the container's own
    // address can only come from a run (which can read the token from /proc/1/environ, so auth is no help).
    const port = new URL(server.baseUrl).port;
    const outcome = await runInSandbox(
      { language: 'bash', code: 'touch should-not-exist', timeoutSeconds: 5 },
      { url: `http://127.0.0.1:${port}`, token: TOKEN },
    );

    expect(outcome).toMatchObject({ ok: false, kind: 'unauthorized', detail: 'runs cannot start other runs' });
    expect(existsSync(path.join(workspace, 'should-not-exist'))).toBe(false);
    expect(server.logs()).toMatch(/refused \/run from 127\.0\.0\.1: a local client/);
    // /health stays open to the container's own healthcheck.
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
  });
});
