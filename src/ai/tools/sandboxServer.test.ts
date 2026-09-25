// End-to-end: the real sidecar (sandbox/server.py) on a loopback port, driven through the bot's own client.
// Skipped where python3 isn't available; CI's test image has it (the base stage installs it for native
// modules), so this runs as part of the gate. The full image, with numpy & co and the container hardening,
// is exercised by sandbox/smoke_test.py in the workflows instead.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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

/** Starts the server on a free port and resolves with its base URL once it logs that it's listening. */
function startServer(workspace: string): Promise<{ child: ChildProcess; baseUrl: string; logs: () => string }> {
  const child = spawn('python3', [SERVER_SCRIPT], {
    env: {
      PATH: process.env.PATH,
      SANDBOX_HOST: '127.0.0.1',
      SANDBOX_PORT: '0',
      SANDBOX_WORKSPACE: workspace,
      SANDBOX_TOKEN: TOKEN,
      // RLIMIT_NPROC counts every process of the user; the test runner itself (as a non-root user in the
      // test container) can already be over the sidecar's default, which would fail any fork in a run.
      SANDBOX_MAX_PROCESSES: '1000000',
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
      const match = /sandbox listening on 127\.0\.0\.1:(\d+)/.exec(output);
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
});
