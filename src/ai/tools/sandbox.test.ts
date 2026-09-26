import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import { FakeProvider } from '../../test-support/fakeProvider';
import { setMemoryStoreForTesting } from '../memory';
import { MemoryStore } from '../memory/memoryStore';
import { toolDefinitions } from '../tools';
import { type ToolHandlerContext, createTurnEffects } from '../types';
import {
  type SandboxRunResult,
  attachFiles,
  clip,
  createNodeHttpFetch,
  createRunCodeTool,
  formatDuration,
  parseLanguage,
  parseRunResult,
  runInSandbox,
  sanitizeFileName,
} from './sandbox';

type FetchCall = { url: string; init: RequestInit };

/** A fetch double: records every call and answers with the given handler. */
function fakeFetch(handler: (call: FetchCall) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function runResult(overrides: Partial<SandboxRunResult> = {}): SandboxRunResult {
  return {
    stdout: '',
    stderr: '',
    exit_code: 0,
    signal: null,
    timed_out: false,
    duration_ms: 42,
    stdout_truncated: false,
    stderr_truncated: false,
    files: [],
    files_omitted: [],
    workspace_reset: false,
    disk_limit_exceeded: false,
    workspace_over_limit: false,
    workspace_limit_mb: 20480,
    ...overrides,
  };
}

function b64(text: string): string {
  return Buffer.from(text).toString('base64');
}

function makeCtx(): ToolHandlerContext {
  return {
    message: createFakeMessage().message,
    provider: new FakeProvider([]),
    channelId: 'channel-1',
    turn: createTurnEffects(),
  };
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

let store: MemoryStore;

beforeEach(() => {
  // logFailure() writes self-diagnosis rows here; an isolated store keeps the tests hermetic and inspectable.
  store = new MemoryStore(':memory:');
  setMemoryStoreForTesting(store);
});

afterEach(() => {
  setMemoryStoreForTesting(undefined);
  vi.unstubAllEnvs();
});

describe('run_code tool', () => {
  it('posts the code to <SANDBOX_URL>/run with the bearer token and returns a compact result', async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(200, runResult({ stdout: '42\n', stderr: 'a warning\n', duration_ms: 1234 })),
    );
    const tool = createRunCodeTool({ url: 'http://sandbox:8080/', token: 'secret', fetch, defaultTimeoutSeconds: 20 });

    const output = await tool.handler(makeCtx(), { language: 'python', code: 'print(6 * 7)' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://sandbox:8080/run');
    expect(calls[0].init.method).toBe('POST');
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer secret');
    expect(bodyOf(calls[0])).toEqual({ language: 'python', code: 'print(6 * 7)', timeout_seconds: 20 });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(output).toBe('Exit code 0 (1.2 s).\nstdout:\n42\nstderr:\na warning');
  });

  it('sends no authorization header when no token is configured', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, runResult({ stdout: 'ok' })));
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', token: '', fetch });

    await tool.handler(makeCtx(), { language: 'bash', code: 'echo ok' });

    expect(new Headers(calls[0].init.headers).has('authorization')).toBe(false);
  });

  it('accepts language aliases and lets timeout_seconds only cut a run shorter than 15 minutes', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, runResult({ stdout: 'x' })));
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });

    await tool.handler(makeCtx(), { language: 'JavaScript', code: 'console.log(1)', timeout_seconds: 5000 });
    await tool.handler(makeCtx(), { language: 'sh', code: 'true', timeout_seconds: '5' });
    await tool.handler(makeCtx(), { language: 'python', code: 'pass' });

    expect(bodyOf(calls[0])).toMatchObject({ language: 'node', timeout_seconds: 900 });
    expect(bodyOf(calls[1])).toMatchObject({ language: 'bash', timeout_seconds: 5 });
    expect(bodyOf(calls[2])).toMatchObject({ language: 'python', timeout_seconds: 900 });
    expect(tool.description).toContain('Runs are cut off after 15 min');
    expect(tool.description).toContain('timeout_seconds only cuts a run shorter');
  });

  it('uses SANDBOX_TIMEOUT_SECONDS as the run limit, which timeout_seconds cannot raise', async () => {
    vi.stubEnv('SANDBOX_TIMEOUT_SECONDS', '7');
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, runResult()));
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });

    await tool.handler(makeCtx(), { language: 'python', code: 'pass' });
    await tool.handler(makeCtx(), { language: 'python', code: 'pass', timeout_seconds: 60 });

    expect(bodyOf(calls[0]).timeout_seconds).toBe(7);
    expect(bodyOf(calls[1]).timeout_seconds).toBe(7);
    expect(tool.description).toContain('cut off after 7 s');
  });

  it('asks the sidecar to wipe the workspace only when reset_workspace is true, and says it happened', async () => {
    const { fetch, calls } = fakeFetch((call) =>
      jsonResponse(200, runResult({ stdout: 'fresh\n', workspace_reset: bodyOf(call).reset_workspace === true })),
    );
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });

    const reset = await tool.handler(makeCtx(), { language: 'bash', code: 'ls', reset_workspace: true });
    const asString = await tool.handler(makeCtx(), { language: 'bash', code: 'ls', reset_workspace: 'true' });
    const kept = await tool.handler(makeCtx(), { language: 'bash', code: 'ls', reset_workspace: false });
    const junk = await tool.handler(makeCtx(), { language: 'bash', code: 'ls', reset_workspace: 'yes please' });

    expect(calls.map((call) => bodyOf(call).reset_workspace)).toEqual([true, true, undefined, undefined]);
    expect(reset).toBe('The workspace was wiped before this run.\nExit code 0 (0.0 s).\nstdout:\nfresh');
    expect(asString).toContain('The workspace was wiped before this run.');
    expect(kept).not.toContain('wiped');
    expect(junk).not.toContain('wiped');
  });

  it('does not claim a clean slate when an outdated sidecar ignored the reset', async () => {
    // A sidecar image from before reset_workspace existed: no workspace_reset field in its answer.
    const { workspace_reset: _dropped, ...oldShape } = runResult({ stdout: 'old files\n' });
    const { fetch } = fakeFetch(() => jsonResponse(200, oldShape));
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });

    const output = await tool.handler(makeCtx(), { language: 'bash', code: 'ls', reset_workspace: true });

    expect(output).toContain("didn't confirm the workspace wipe");
    expect(output).not.toContain('was wiped');
  });

  it('describes reset_workspace to the model as opt-in', () => {
    const tool = createRunCodeTool({ url: 'http://sandbox:8080' });
    const properties = tool.parameters.properties as Record<string, { type: string }>;
    expect(properties.reset_workspace.type).toBe('boolean');
    expect(tool.parameters.required).toEqual(['language', 'code']);
    expect(tool.description).toContain('reset_workspace: true');
  });

  it('rejects unusable arguments without calling the sidecar', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, runResult()));
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });

    expect(await tool.handler(makeCtx(), { language: 'ruby', code: 'puts 1' })).toContain('Unsupported language');
    expect(await tool.handler(makeCtx(), { language: 'python', code: '   ' })).toBe('No code to run.');
    expect(await tool.handler(makeCtx(), { language: 'python', code: 'x'.repeat(100_001) })).toContain('too long');
    expect(calls).toHaveLength(0);
  });

  it('attaches the files the run wrote to out/ to the turn', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const { fetch } = fakeFetch(() =>
      jsonResponse(
        200,
        runResult({
          files: [
            { name: 'chart.png', size: png.length, content_base64: png.toString('base64') },
            { name: 'data.csv', size: 3, content_base64: b64('a,b') },
          ],
          files_omitted: [{ name: 'huge.bin', size: 3e7, reason: 'over the 10 MB per-file limit' }],
        }),
      ),
    );
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });
    const ctx = makeCtx();

    const output = await tool.handler(ctx, { language: 'python', code: 'plot()' });

    expect(ctx.turn.files.map((f) => f.name)).toEqual(['chart.png', 'data.csv']);
    expect(ctx.turn.files[0].attachment.equals(png)).toBe(true);
    expect(ctx.turn.files[1].attachment.toString()).toBe('a,b');
    expect(output).toContain('Attached to your reply: chart.png (7 B), data.csv (3 B).');
    expect(output).toContain('Not attached: huge.bin (over the 10 MB per-file limit).');
    expect(output).toContain('No output: print() whatever you want to see.');
  });

  it('replaces a same-named file from an earlier run in the same turn instead of attaching both', async () => {
    let version = 0;
    const { fetch } = fakeFetch(() => {
      version++;
      return jsonResponse(
        200,
        runResult({ files: [{ name: 'chart.png', size: 2, content_base64: b64(`v${version}`) }] }),
      );
    });
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });
    const ctx = makeCtx();

    await tool.handler(ctx, { language: 'python', code: 'plot()' });
    await tool.handler(ctx, { language: 'python', code: 'plot(fixed=True)' });

    expect(ctx.turn.files).toHaveLength(1);
    expect(ctx.turn.files[0].attachment.toString()).toBe('v2');
  });

  it('reports a timed-out run with its partial output', async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(
        200,
        runResult({ stdout: 'started\n', exit_code: -9, signal: 'SIGKILL', timed_out: true, duration_ms: 20_000 }),
      ),
    );
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });

    const output = await tool.handler(makeCtx(), { language: 'bash', code: 'echo started; sleep 99' });

    expect(output).toBe('Timed out after 20.0 s and was killed; output so far is below.\nstdout:\nstarted');
  });

  it('explains a run killed by a resource limit', async () => {
    const { fetch } = fakeFetch(() => jsonResponse(200, runResult({ exit_code: -9, signal: 'SIGKILL' })));
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });

    const output = await tool.handler(makeCtx(), { language: 'python', code: 'x = [0] * 10**10' });

    expect(output).toContain('Killed by SIGKILL (usually the memory limit)');
    expect(output).toContain('No output.');
  });

  it('says when a run was killed for filling the disk and the workspace was wiped', async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(
        200,
        runResult({
          exit_code: -9,
          signal: 'SIGKILL',
          duration_ms: 3100,
          disk_limit_exceeded: true,
          workspace_over_limit: true,
          workspace_limit_mb: 20480,
        }),
      ),
    );
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });

    const output = await tool.handler(makeCtx(), { language: 'bash', code: 'yes > big' });

    expect(output).toContain("Killed after 3.1 s: /workspace went over the sandbox's disk limit (20480 MB).");
    expect(output).not.toContain('memory limit');
    expect(output).toContain('/workspace was over its size limit (20480 MB) after this run, so the sandbox wiped it');
  });

  it('reads a result from a sidecar without the disk limit fields', () => {
    const { disk_limit_exceeded: _a, workspace_over_limit: _b, workspace_limit_mb: _c, ...oldShape } = runResult();
    expect(parseRunResult(oldShape)).toMatchObject({
      disk_limit_exceeded: false,
      workspace_over_limit: false,
      workspace_limit_mb: null,
    });
  });

  it('keeps the head and tail of long output for the model', async () => {
    const stdout = `${'a'.repeat(5000)}THE-END`;
    const { fetch } = fakeFetch(() => jsonResponse(200, runResult({ stdout, stdout_truncated: true })));
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });

    const output = await tool.handler(makeCtx(), { language: 'python', code: 'spam()' });

    expect(output).toContain('stdout (truncated by the sandbox):');
    expect(output).toContain('chars omitted');
    expect(output).toContain('THE-END');
    expect(output.length).toBeLessThan(4300);
  });

  it('tells the model when the sidecar is down and logs a self-diagnosis entry', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const { fetch } = fakeFetch(() => Promise.reject(refused));
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });

    const output = await tool.handler(makeCtx(), { language: 'python', code: 'print(1)' });

    expect(output).toContain("isn't working right now, so nothing ran");
    const diagnosis = store.getByCategory('tool_error', 10).map((m) => m.content);
    expect(diagnosis).toEqual(['run_code: sandbox unreachable (ECONNREFUSED)']);
  });

  it('suggests one retry with reset_workspace when the sidecar fails to start a run', async () => {
    const { fetch } = fakeFetch(() => jsonResponse(500, { error: 'could not start the run: Permission denied' }));
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });

    const output = await tool.handler(makeCtx(), { language: 'python', code: 'print(1)' });

    expect(output).toContain("isn't working right now, so nothing ran.");
    expect(output).toContain('It reported: could not start the run: Permission denied.');
    expect(output).toContain('retry once with reset_workspace: true');
  });

  it('turns an HTTP timeout into an "unknown result" answer', async () => {
    const { fetch } = fakeFetch(() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')));
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });

    const output = await tool.handler(makeCtx(), { language: 'python', code: 'while True: pass' });

    expect(output).toContain("didn't answer in time");
    expect(store.getByCategory('tool_error', 10)).toHaveLength(1);
  });

  it('tells the model the sidecar is busy, without a self-diagnosis entry', async () => {
    const { fetch } = fakeFetch(() => jsonResponse(429, { error: 'sandbox is busy with another run' }));
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });

    const output = await tool.handler(makeCtx(), { language: 'python', code: 'print(1)' });

    expect(output).toBe(
      "The sandbox is busy with another run, so nothing ran. Don't keep retrying: say it's busy and when to try again.",
    );
    expect(store.getByCategory('tool_error', 10)).toHaveLength(0);
  });

  it("says how far along the run holding the sidecar is, so the model can tell people when to try again", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(503, { error: 'sandbox is busy with another run', busy_for_seconds: 190, busy_limit_seconds: 900 }),
    );
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });

    const output = await tool.handler(makeCtx(), { language: 'python', code: 'print(1)' });

    expect(output).toBe(
      "The sandbox is busy with another run (it has been going for 3 min and may take up to 12 min more), so nothing ran. Don't keep retrying: say it's busy and when to try again.",
    );
  });

  it("passes the sidecar's validation message through so the model can fix its request", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(413, { error: 'code is over 256 KB' }));
    const tool = createRunCodeTool({ url: 'http://sandbox:8080', fetch });

    const output = await tool.handler(makeCtx(), { language: 'python', code: 'print(1)' });

    expect(output).toBe('The sandbox rejected the request: code is over 256 KB. Nothing ran.');
  });

  it('is only offered when SANDBOX_URL is set', () => {
    vi.stubEnv('SANDBOX_URL', undefined);
    const tool = createRunCodeTool();
    expect(tool.isEnabled?.()).toBe(false);

    vi.stubEnv('SANDBOX_URL', 'http://sandbox:8080');
    expect(tool.isEnabled?.()).toBe(true);
  });

  it('is registered in the shared tool list', () => {
    expect(toolDefinitions.some((t) => t.name === 'run_code')).toBe(true);
  });
});

describe('runInSandbox', () => {
  const request = { language: 'python' as const, code: 'print(1)', timeoutSeconds: 10 };

  it('maps HTTP failures to typed outcomes', async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, { error: 'unauthorized' }, 'unauthorized'],
      [403, {}, 'unauthorized'],
      [503, { error: 'sandbox is busy with another run' }, 'busy'],
      [500, { error: 'sandbox workspace is not writable' }, 'server_error'],
      [400, { error: 'language must be one of: python, bash, node' }, 'rejected'],
    ];
    for (const [status, body, kind] of cases) {
      const { fetch } = fakeFetch(() => jsonResponse(status, body));
      const outcome = await runInSandbox(request, { url: 'http://sandbox:8080', fetch });
      expect(outcome).toMatchObject({ ok: false, kind });
    }
  });

  it('falls back to the status code when an error body is not JSON', async () => {
    const { fetch } = fakeFetch(() => new Response('<html>Bad Gateway</html>', { status: 502 }));
    const outcome = await runInSandbox(request, { url: 'http://sandbox:8080', fetch });
    expect(outcome).toEqual({ ok: false, kind: 'server_error', detail: 'HTTP 502' });
  });

  it('flags a 200 response that is not a run result', async () => {
    const { fetch } = fakeFetch(() => new Response('not json', { status: 200 }));
    expect(await runInSandbox(request, { url: 'http://sandbox:8080', fetch })).toMatchObject({ kind: 'bad_response' });

    const { fetch: fetch2 } = fakeFetch(() => jsonResponse(200, { hello: 'world' }));
    expect(await runInSandbox(request, { url: 'http://sandbox:8080', fetch: fetch2 })).toMatchObject({
      kind: 'bad_response',
    });
  });

  it('refuses a missing or non-http SANDBOX_URL without fetching', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, runResult()));
    vi.stubEnv('SANDBOX_URL', undefined);
    expect(await runInSandbox(request, { fetch })).toMatchObject({ ok: false, kind: 'unconfigured' });
    expect(await runInSandbox(request, { url: 'file:///etc/passwd', fetch })).toMatchObject({ kind: 'unconfigured' });
    expect(await runInSandbox(request, { url: 'not a url', fetch })).toMatchObject({ kind: 'unconfigured' });
    expect(calls).toHaveLength(0);
  });

  it('gives the HTTP call the run timeout plus the queue and transport grace', async () => {
    const setTimeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const { fetch } = fakeFetch(() => jsonResponse(200, runResult()));
    await runInSandbox(request, { url: 'http://sandbox:8080', fetch });
    expect(setTimeoutSpy).toHaveBeenCalledWith((10 + 30 + 30) * 1000);
    setTimeoutSpy.mockRestore();
  });
});

describe('the default transport (node:http, not the global fetch)', () => {
  type Seen = { method?: string; headers: IncomingMessage['headers']; body: string };
  let server: Server | undefined;

  /** A local HTTP server; `handle` answers each request after its body has been read. */
  async function serve(handle: (res: ServerResponse, seen: Seen) => void): Promise<{ url: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const entry = { method: req.method, headers: req.headers, body };
        seen.push(entry);
        handle(res, entry);
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, seen };
  }

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
  });

  it('is what runInSandbox uses when no fetch is injected: POST with the token, JSON body, JSON answer', async () => {
    const { url, seen } = await serve((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(runResult({ stdout: 'hi\n' })));
    });

    const outcome = await runInSandbox(
      { language: 'bash', code: 'echo hi', timeoutSeconds: 5 },
      { url: `${url}/`, token: 'secret' },
    );

    expect(outcome).toMatchObject({ ok: true, result: { stdout: 'hi\n' } });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].headers.authorization).toBe('Bearer secret');
    expect(seen[0].headers['content-length']).toBe(String(Buffer.byteLength(seen[0].body)));
    expect(JSON.parse(seen[0].body)).toEqual({ language: 'bash', code: 'echo hi', timeout_seconds: 5 });
  });

  it('maps an error answer to its typed outcome, busy details included', async () => {
    const { url } = await serve((res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'sandbox is busy with another run', busy_for_seconds: 5, busy_limit_seconds: 900 }));
    });

    const outcome = await runInSandbox({ language: 'bash', code: 'true', timeoutSeconds: 5 }, { url });

    expect(outcome).toEqual({
      ok: false,
      kind: 'busy',
      detail: 'sandbox is busy with another run',
      busy: { runningSeconds: 5, limitSeconds: 900 },
    });
  });

  it("gives up only when the caller's signal says so: before the headers, or halfway through the body", async () => {
    const nodeFetch = createNodeHttpFetch();
    const init = (ms: number) => ({ method: 'POST', headers: {}, body: '{}', signal: AbortSignal.timeout(ms) });

    const silent = await serve(() => {
      // Never answers.
    });
    const beforeHeaders = await nodeFetch(silent.url, init(100)).then(
      () => 'resolved',
      (error: Error) => error.name,
    );
    expect(['AbortError', 'TimeoutError']).toContain(beforeHeaders);
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));

    const stalled = await serve((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"stdout": "par');
    });
    const midBody = await nodeFetch(stalled.url, init(100)).then(
      () => 'resolved',
      (error: Error) => error.name,
    );
    expect(['AbortError', 'TimeoutError']).toContain(midBody);
  });

  it('refuses an answer over its size cap, and builds bodiless responses', async () => {
    const big = await serve((res) => {
      res.writeHead(200);
      res.end('x'.repeat(2048));
    });
    const capped = createNodeHttpFetch(1024);
    const init = { method: 'POST', headers: {}, body: '{}', signal: AbortSignal.timeout(5000) };
    await expect(capped(big.url, init)).rejects.toThrow("the sandbox's answer is over 1024 bytes");
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));

    const empty = await serve((res) => {
      res.writeHead(204, { 'x-test': 'yes' });
      res.end();
    });
    const response = await createNodeHttpFetch()(empty.url, init);
    expect(response.status).toBe(204);
    expect(response.headers.get('x-test')).toBe('yes');
    expect(await response.text()).toBe('');
  });
});

describe('sandbox helpers', () => {
  it('parseLanguage maps aliases and rejects unknown languages', () => {
    expect(parseLanguage(' Python3 ')).toBe('python');
    expect(parseLanguage('nodejs')).toBe('node');
    expect(parseLanguage('shell')).toBe('bash');
    expect(parseLanguage('ruby')).toBeUndefined();
    expect(parseLanguage(3)).toBeUndefined();
  });

  it('parseRunResult drops malformed file entries and defaults optional fields', () => {
    const parsed = parseRunResult({
      exit_code: 1,
      files: [{ name: 'ok.txt', size: 2, content_base64: b64('ok') }, { name: 'bad' }, 'junk'],
      files_omitted: [{ name: 'x', reason: 'too many' }, { nope: true }],
    });
    expect(parsed).toMatchObject({
      stdout: '',
      stderr: '',
      exit_code: 1,
      signal: null,
      timed_out: false,
      workspace_reset: false,
    });
    expect(parsed?.files.map((f) => f.name)).toEqual(['ok.txt']);
    expect(parsed?.files_omitted).toEqual([{ name: 'x', size: null, reason: 'too many' }]);
    expect(parseRunResult({ stdout: 'no exit code' })).toBeUndefined();
    expect(parseRunResult(null)).toBeUndefined();
  });

  it('sanitizeFileName strips paths and odd characters but keeps the extension', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('my chart (final).png')).toBe('my_chart_final_.png');
    expect(sanitizeFileName('.hidden')).toBe('hidden');
    expect(sanitizeFileName('')).toBe('file');
    const long = sanitizeFileName(`${'x'.repeat(150)}.png`);
    expect(long).toHaveLength(100);
    expect(long.endsWith('.png')).toBe(true);
  });

  it('clip keeps the head and the tail', () => {
    expect(clip('short', 10)).toBe('short');
    const clipped = clip(`${'a'.repeat(50)}${'z'.repeat(50)}`, 20);
    expect(clipped.startsWith('a'.repeat(14))).toBe(true);
    expect(clipped.endsWith('z'.repeat(6))).toBe(true);
    expect(clipped).toContain('[80 chars omitted]');
  });

  it('attachFiles caps the reply at 10 files, 10 MB each and 25 MB in all, and skips empty files', () => {
    const turn = createTurnEffects();
    for (let i = 0; i < 9; i++) turn.files.push({ attachment: Buffer.from('x'), name: `pre-${i}.txt` });

    const report = attachFiles(turn, [
      { name: 'empty.txt', size: 0, content_base64: '' },
      { name: 'tenth.txt', size: 1, content_base64: b64('y') },
      { name: 'eleventh.txt', size: 1, content_base64: b64('z') },
    ]);

    expect(report.attached.map((f) => f.name)).toEqual(['tenth.txt']);
    expect(report.skipped.map((f) => f.name)).toEqual(['empty.txt', 'eleventh.txt']);
    expect(turn.files).toHaveLength(10);

    const MB = 1024 * 1024;
    const file = (name: string, bytes: number) => ({ name, size: bytes, content_base64: Buffer.alloc(bytes).toString('base64') });
    const big = createTurnEffects();
    big.files.push({ attachment: Buffer.alloc(9 * MB), name: 'image.png' });
    const bigReport = attachFiles(big, [
      file('huge.bin', 10 * MB + 1),
      file('a.bin', 10 * MB),
      file('b.bin', 6 * MB),
      file('c.bin', 6 * MB),
    ]);
    expect(bigReport.attached.map((f) => f.name)).toEqual(['a.bin', 'b.bin']);
    expect(bigReport.skipped).toEqual([
      { name: 'huge.bin', reason: "over Discord's 10 MB per-file limit" },
      { name: 'c.bin', reason: 'the reply would go over the 25 MB attachment limit' },
    ]);
  });

  it('formatDuration speaks in minutes from two minutes up', () => {
    expect(formatDuration(900)).toBe('15 min');
    expect(formatDuration(720)).toBe('12 min');
    expect(formatDuration(190)).toBe('3 min');
    expect(formatDuration(60)).toBe('1 min');
    expect(formatDuration(90)).toBe('90 s');
    expect(formatDuration(20)).toBe('20 s');
  });
});
