// run_code: execute code in the sidecar sandbox container (only offered when SANDBOX_URL is set).
//
// Why a sidecar instead of letting the bot run commands in its own container: that container holds the
// Discord token and the OpenRouter key, and the model reads arbitrary chat messages and web pages. One
// prompt-injected command could exfiltrate both. The sidecar (sandbox/server.py) holds no secrets, so the
// worst a hijacked run can do is burn its CPU quota or scribble in its own /workspace.
import http from 'node:http';
import https from 'node:https';
import { config } from '../../config';
import { logger } from '../../logger';
import { logFailure } from '../failureLogger';
import type { ToolDefinition, ToolHandlerContext, TurnEffects } from '../types';

export const SANDBOX_LANGUAGES = ['python', 'bash', 'node'] as const;
export type SandboxLanguage = (typeof SANDBOX_LANGUAGES)[number];

// Models name languages loosely; anything that unambiguously means one of the three is accepted.
const LANGUAGE_ALIASES: Record<string, SandboxLanguage> = {
  python: 'python',
  python3: 'python',
  py: 'python',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  node: 'node',
  nodejs: 'node',
  javascript: 'node',
  js: 'node',
};

/** The longest run there is: 15 minutes (the sidecar's own SANDBOX_MAX_TIMEOUT_SECONDS default). */
export const MAX_RUN_TIMEOUT_SECONDS = 900;
// How long a run may sit behind another one in the sidecar's queue (its SANDBOX_QUEUE_WAIT_SECONDS default),
// plus slack for the sidecar's own work around the run (a requested wipe and the disk walk afterwards, both
// proportional to a workspace of up to 20 GB; up to 25 MB of files to encode) and the round trip. The HTTP
// timeout covers all of it.
const QUEUE_GRACE_SECONDS = 30;
const TRANSPORT_GRACE_SECONDS = 30;
// The biggest answer accepted: 25 MB of files as base64 plus the capped output streams, with room to spare.
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
// The sidecar refuses code over 256 KB; anything near that is data that belongs in a file or a URL.
const MAX_CODE_CHARS = 100_000;
// What the model sees of each stream. The sidecar already caps them at 16 KB, but every tool result stays
// in the conversation for the rest of the window, so the model gets a tighter cut.
const MODEL_STDOUT_CHARS = 4000;
const MODEL_STDERR_CHARS = 2000;
// Discord allows 10 attachments per message, each within its default 10 MB upload limit; 25 MB in all keeps one
// reply's upload reasonable. The sidecar applies the same caps to what one run returns.
const MAX_TURN_FILES = 10;
const MAX_TURN_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TURN_TOTAL_BYTES = 25 * 1024 * 1024;

export type SandboxFile = { name: string; size: number; content_base64: string };
export type SandboxOmittedFile = { name: string; size: number | null; reason: string };

/** The sidecar's POST /run response. */
export type SandboxRunResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  /** 'SIGKILL' etc. when the process was killed by a signal. */
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  files: SandboxFile[];
  files_omitted: SandboxOmittedFile[];
  /** True when the sidecar wiped /workspace before the run (it only does when asked). */
  workspace_reset: boolean;
  /** The run was killed because /workspace went over the sidecar's disk limit. */
  disk_limit_exceeded: boolean;
  /** /workspace was over its limit after the run, so the sidecar wiped it (outputs in `files` still came back). */
  workspace_over_limit: boolean;
  /** The sidecar's SANDBOX_WORKSPACE_MAX_MB; null from a sidecar without the limit. */
  workspace_limit_mb: number | null;
};

export type SandboxFailureKind =
  | 'unconfigured'
  | 'unreachable'
  | 'timeout'
  | 'busy'
  | 'unauthorized'
  | 'rejected'
  | 'server_error'
  | 'bad_response';

/** How far along the run holding the sidecar is, when a request was turned away as busy. */
export type SandboxBusyInfo = { runningSeconds: number; limitSeconds: number };

export type SandboxOutcome =
  | { ok: true; result: SandboxRunResult }
  | { ok: false; kind: SandboxFailureKind; detail: string; busy?: SandboxBusyInfo };

export type SandboxRunRequest = {
  language: SandboxLanguage;
  code: string;
  timeoutSeconds: number;
  /** Wipe /workspace (saved files, pip/npm installs) before the run. */
  resetWorkspace?: boolean;
};

/** The part of fetch() the client uses. Tests inject a fake; the default is createNodeHttpFetch()'s. */
export type SandboxFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<Response>;

export type SandboxClientOptions = {
  /** Defaults to SANDBOX_URL. */
  url?: string;
  /** Defaults to SANDBOX_TOKEN. */
  token?: string;
  /** Defaults to createNodeHttpFetch()'s transport (never the global fetch: see there). */
  fetch?: SandboxFetch;
};

export type RunCodeToolOptions = SandboxClientOptions & {
  /** The run time limit; timeout_seconds can only shorten it. Defaults to SANDBOX_TIMEOUT_SECONDS. */
  defaultTimeoutSeconds?: number;
};

export function parseLanguage(raw: unknown): SandboxLanguage | undefined {
  if (typeof raw !== 'string') return undefined;
  return LANGUAGE_ALIASES[raw.trim().toLowerCase()];
}

// Models send booleans as strings now and then; only an unambiguous yes wipes anything.
function parseFlag(raw: unknown): boolean {
  return raw === true || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true');
}

/** The configured run limit (SANDBOX_TIMEOUT_SECONDS or the option), within 1..MAX_RUN_TIMEOUT_SECONDS. */
function clampRunLimit(seconds: number): number {
  if (!Number.isFinite(seconds)) return MAX_RUN_TIMEOUT_SECONDS;
  return Math.min(MAX_RUN_TIMEOUT_SECONDS, Math.max(1, Math.round(seconds)));
}

/** The model's timeout_seconds: it may only cut a run shorter than `limit`. */
function parseTimeoutSeconds(raw: unknown, limit: number): number {
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return limit;
  return Math.min(limit, Math.max(1, Math.round(value)));
}

function runEndpoint(baseUrl: string): string | undefined {
  try {
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/run`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the sidecar's JSON; undefined when it isn't a run result at all. Lenient about optional parts. */
export function parseRunResult(raw: unknown): SandboxRunResult | undefined {
  if (!isRecord(raw) || typeof raw.exit_code !== 'number') return undefined;
  const files: SandboxFile[] = Array.isArray(raw.files)
    ? raw.files.filter(
        (f): f is SandboxFile =>
          isRecord(f) &&
          typeof f.name === 'string' &&
          typeof f.content_base64 === 'string' &&
          typeof f.size === 'number',
      )
    : [];
  const omitted: SandboxOmittedFile[] = Array.isArray(raw.files_omitted)
    ? raw.files_omitted
        .filter((f): f is Record<string, unknown> => isRecord(f) && typeof f.name === 'string')
        .map((f) => ({
          name: String(f.name),
          size: typeof f.size === 'number' ? f.size : null,
          reason: typeof f.reason === 'string' ? f.reason : 'not returned',
        }))
    : [];
  return {
    stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
    stderr: typeof raw.stderr === 'string' ? raw.stderr : '',
    exit_code: raw.exit_code,
    signal: typeof raw.signal === 'string' ? raw.signal : null,
    timed_out: raw.timed_out === true,
    duration_ms: typeof raw.duration_ms === 'number' ? raw.duration_ms : 0,
    stdout_truncated: raw.stdout_truncated === true,
    stderr_truncated: raw.stderr_truncated === true,
    files,
    files_omitted: omitted,
    workspace_reset: raw.workspace_reset === true,
    disk_limit_exceeded: raw.disk_limit_exceeded === true,
    workspace_over_limit: raw.workspace_over_limit === true,
    workspace_limit_mb: typeof raw.workspace_limit_mb === 'number' ? raw.workspace_limit_mb : null,
  };
}

async function readErrorBody(response: Response): Promise<{ detail: string; busy?: SandboxBusyInfo }> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Not JSON (a proxy's error page, say): the status code is all there is.
  }
  const detail = isRecord(body) && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
  if (!isRecord(body)) return { detail };
  const running = body.busy_for_seconds;
  const limit = body.busy_limit_seconds;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return valid(running) && valid(limit)
    ? { detail, busy: { runningSeconds: running, limitSeconds: limit } }
    : { detail };
}

// Response bodies that must be empty: new Response() refuses one for these statuses.
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * fetch() for the sidecar over node:http(s). Node's global fetch (undici) gives up on a response whose
 * headers or body take longer than 300 s, and the sidecar answers only once the run is over (up to 15 min):
 * a long run would fail on the bot's side while the sidecar was still working on it. Here the caller's
 * signal is the only deadline. One connection per run (agent: false: no pool, so no idle-socket timeout).
 */
export function createNodeHttpFetch(maxResponseBytes = MAX_RESPONSE_BYTES): SandboxFetch {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const target = new URL(url);
      const body = Buffer.from(init.body);
      const request = (target.protocol === 'https:' ? https : http).request(target, {
        method: init.method,
        headers: { ...init.headers, 'content-length': String(body.length) },
        signal: init.signal,
        agent: false,
      });
      // The connection sits idle while the run works: TCP keep-alive notices a sidecar that vanished.
      request.on('socket', (socket) => socket.setKeepAlive(true, 60_000));
      request.on('error', reject);
      request.on('response', (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            // Rejected here, before 'end' (which can still follow in the same tick) could resolve it.
            reject(new Error(`the sandbox's answer is over ${maxResponseBytes} bytes`));
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('close', () => {
          // Settles nothing when 'end' already resolved: a promise settles once.
          if (!incoming.complete) {
            reject(init.signal.aborted ? init.signal.reason : new Error('the connection closed mid-answer'));
          }
        });
        incoming.on('end', () => {
          const status = incoming.statusCode ?? 0;
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
              headers.append(name, item);
            }
          }
          try {
            resolve(new Response(NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks), { status, headers }));
          } catch (error) {
            reject(error);
          }
        });
      });
      request.end(body);
    });
}

const nodeHttpFetch = createNodeHttpFetch();

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // A fetch() reports "fetch failed" with the useful part (ECONNREFUSED, ENOTFOUND, …) in `cause`; node:http
  // puts it in the message ("connect ECONNREFUSED 10.0.0.2:8080").
  const cause = (error as Error & { cause?: unknown }).cause;
  if (isRecord(cause) && typeof cause.code === 'string') return cause.code;
  if (cause instanceof Error) return cause.message;
  return error.message;
}

/** POSTs one run to the sidecar. Never throws: every failure comes back as a typed outcome. */
export async function runInSandbox(
  request: SandboxRunRequest,
  opts: SandboxClientOptions = {},
): Promise<SandboxOutcome> {
  const baseUrl = opts.url ?? config.sandbox.url;
  if (!baseUrl) return { ok: false, kind: 'unconfigured', detail: 'SANDBOX_URL is not set' };
  const endpoint = runEndpoint(baseUrl);
  if (!endpoint) return { ok: false, kind: 'unconfigured', detail: `SANDBOX_URL "${baseUrl}" is not an http(s) URL` };

  const token = opts.token ?? config.sandbox.token;
  const fetchImpl = opts.fetch ?? nodeHttpFetch;
  const budgetSeconds = request.timeoutSeconds + QUEUE_GRACE_SECONDS + TRANSPORT_GRACE_SECONDS;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        language: request.language,
        code: request.code,
        timeout_seconds: request.timeoutSeconds,
        ...(request.resetWorkspace ? { reset_workspace: true } : {}),
      }),
      signal: AbortSignal.timeout(budgetSeconds * 1000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return { ok: false, kind: 'timeout', detail: `no answer within ${budgetSeconds} s` };
    }
    return { ok: false, kind: 'unreachable', detail: describeFetchError(error) };
  }

  if (!response.ok) {
    const { detail, busy } = await readErrorBody(response);
    if (response.status === 401 || response.status === 403) return { ok: false, kind: 'unauthorized', detail };
    if (response.status === 429 || response.status === 503) {
      return { ok: false, kind: 'busy', detail, ...(busy ? { busy } : {}) };
    }
    if (response.status >= 500) return { ok: false, kind: 'server_error', detail };
    return { ok: false, kind: 'rejected', detail };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return { ok: false, kind: 'timeout', detail: `no complete answer within ${budgetSeconds} s` };
    }
    return { ok: false, kind: 'bad_response', detail: 'response was not JSON' };
  }
  const result = parseRunResult(body);
  if (!result) return { ok: false, kind: 'bad_response', detail: 'response was not a run result' };
  return { ok: true, result };
}

/** Keeps the head and the tail of an over-long text (the answer is often at the end of a long output). */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n… [${text.length - head - tail} chars omitted] …\n${text.slice(text.length - tail)}`;
}

/** Discord-safe attachment name: the bare file name, no path, no odd characters. */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '');
  if (!cleaned) return 'file';
  if (cleaned.length <= 100) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 100 - ext.length) + ext;
}

type AttachReport = {
  attached: Array<{ name: string; bytes: number }>;
  skipped: Array<{ name: string; reason: string }>;
};

/**
 * Queues the run's files on this turn's reply. A file named like one an earlier run attached this turn replaces
 * it (the model re-running a fixed chart script should post the fixed chart once, not both).
 */
export function attachFiles(turn: TurnEffects, files: SandboxFile[]): AttachReport {
  const report: AttachReport = { attached: [], skipped: [] };
  for (const file of files) {
    const name = sanitizeFileName(file.name);
    const attachment = Buffer.from(file.content_base64, 'base64');
    if (attachment.length === 0) {
      // Discord refuses empty attachments, and one bad file would sink the whole reply.
      report.skipped.push({ name, reason: 'the file is empty' });
      continue;
    }
    const others = turn.files.filter((existing) => existing.name !== name);
    const otherBytes = others.reduce((sum, existing) => sum + existing.attachment.length, 0);
    if (others.length >= MAX_TURN_FILES) {
      report.skipped.push({ name, reason: `the reply already carries ${MAX_TURN_FILES} files` });
      continue;
    }
    if (attachment.length > MAX_TURN_FILE_BYTES) {
      report.skipped.push({ name, reason: `over Discord's ${MAX_TURN_FILE_BYTES / (1024 * 1024)} MB per-file limit` });
      continue;
    }
    if (otherBytes + attachment.length > MAX_TURN_TOTAL_BYTES) {
      report.skipped.push({
        name,
        reason: `the reply would go over the ${MAX_TURN_TOTAL_BYTES / (1024 * 1024)} MB attachment limit`,
      });
      continue;
    }
    turn.files.splice(0, turn.files.length, ...others, { attachment, name });
    report.attached.push({ name, bytes: attachment.length });
  }
  return report;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SIGNAL_HINTS: Record<string, string> = {
  SIGKILL: 'usually the memory limit',
  SIGXCPU: 'the CPU time limit',
  SIGXFSZ: 'the file size limit',
  SIGSEGV: 'a crash',
};

/** The compact text the model gets back for a finished run. */
export function formatRunResult(result: SandboxRunResult, files: AttachReport, resetRequested = false): string {
  const seconds = (result.duration_ms / 1000).toFixed(1);
  const lines: string[] = [];
  if (resetRequested) {
    // A sidecar image older than the reset option ignores the flag; say so rather than claim a clean slate.
    lines.push(
      result.workspace_reset
        ? 'The workspace was wiped before this run.'
        : "The sandbox didn't confirm the workspace wipe (it may be out of date), so earlier files may still be there.",
    );
  }
  const diskLimit = result.workspace_limit_mb !== null ? ` (${result.workspace_limit_mb} MB)` : '';
  if (result.timed_out) {
    lines.push(`Timed out after ${seconds} s and was killed; output so far is below.`);
  } else if (result.disk_limit_exceeded) {
    lines.push(`Killed after ${seconds} s: /workspace went over the sandbox's disk limit${diskLimit}.`);
  } else if (result.signal) {
    const hint = SIGNAL_HINTS[result.signal];
    lines.push(`Killed by ${result.signal}${hint ? ` (${hint})` : ''} after ${seconds} s.`);
  } else {
    lines.push(`Exit code ${result.exit_code} (${seconds} s).`);
  }

  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();
  if (!stdout && !stderr) {
    lines.push(result.exit_code === 0 ? 'No output: print() whatever you want to see.' : 'No output.');
  }
  if (stdout) {
    const note = result.stdout_truncated ? ' (truncated by the sandbox)' : '';
    lines.push(`stdout${note}:\n${clip(stdout, MODEL_STDOUT_CHARS)}`);
  }
  if (stderr) {
    const note = result.stderr_truncated ? ' (truncated by the sandbox)' : '';
    lines.push(`stderr${note}:\n${clip(stderr, MODEL_STDERR_CHARS)}`);
  }

  if (files.attached.length > 0) {
    const list = files.attached.map((f) => `${f.name} (${formatBytes(f.bytes)})`).join(', ');
    lines.push(`Attached to your reply: ${list}. Don't paste their contents or links; they're already there.`);
  }
  const notAttached = [
    ...result.files_omitted.map((f) => `${f.name} (${f.reason})`),
    ...files.skipped.map((f) => `${f.name} (${f.reason})`),
  ];
  if (notAttached.length > 0) lines.push(`Not attached: ${notAttached.join('; ')}.`);
  if (result.workspace_over_limit) {
    lines.push(
      `/workspace was over its size limit${diskLimit} after this run, so the sandbox wiped it: saved files and installed packages are gone.`,
    );
  }
  return lines.join('\n');
}

/** What the model hears when nothing ran; failures that need the owner's attention are also logged. */
function describeFailure(outcome: Extract<SandboxOutcome, { ok: false }>): string {
  switch (outcome.kind) {
    case 'busy': {
      logger.warn(`run_code: sandbox busy (${outcome.detail})`);
      // Runs can take up to 15 minutes, and a request already waited in the sidecar's queue before this: a
      // tight retry loop would only burn the turn. The model should hand the wait to the people asking.
      const busy = outcome.busy;
      const progress = busy
        ? ` (it has been going for ${formatDuration(busy.runningSeconds)} and may take up to ${formatDuration(Math.max(0, busy.limitSeconds - busy.runningSeconds))} more)`
        : '';
      return `The sandbox is busy with another run${progress}, so nothing ran. Don't keep retrying: say it's busy and when to try again.`;
    }
    case 'rejected':
      // The model's request itself (bad language, oversized code): it can fix and retry.
      logger.warn(`run_code: sandbox rejected the request (${outcome.detail})`);
      return `The sandbox rejected the request: ${outcome.detail}. Nothing ran.`;
    case 'timeout':
      logger.warn(`run_code: sandbox request timed out (${outcome.detail})`);
      logFailure('tool_error', `run_code: sandbox request timed out (${outcome.detail})`);
      return "The sandbox didn't answer in time, so the result is unknown. Don't guess it.";
    default: {
      const hint = outcome.kind === 'unauthorized' ? '; SANDBOX_TOKEN must match on the bot and the sandbox' : '';
      logger.error(`run_code: sandbox ${outcome.kind} (${outcome.detail})${hint}`);
      logFailure('tool_error', `run_code: sandbox ${outcome.kind} (${outcome.detail})`);
      // The sidecar answered but failed (e.g. something an earlier run left in /workspace): a clean slate
      // is the one thing the model can try.
      const retry =
        outcome.kind === 'server_error'
          ? ` It reported: ${outcome.detail}. If you haven't yet, retry once with reset_workspace: true (it wipes files from earlier runs).`
          : '';
      return `The code sandbox isn't working right now, so nothing ran.${retry} Otherwise say so, or work it out by hand and say that's what you did; don't present a guess as a computed result.`;
    }
  }
}

/** 900 → "15 min", 20 → "20 s": how the model and the people it answers think about run times. */
export function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole >= 120 || (whole >= 60 && whole % 60 === 0)) return `${Math.round(whole / 60)} min`;
  return `${whole} s`;
}

function describeTool(runLimitSeconds: number): string {
  return [
    'Run a program on your own sandbox computer and get its output.',
    "Use it for any arithmetic you'd otherwise eyeball (bill splits, tips, unit or currency conversions, date and time math), data crunching, simulations, and making charts or files.",
    'Languages: python (numpy, pandas, matplotlib, sympy, requests preinstalled), bash (curl, jq, bc) or node.',
    'Only stdout/stderr come back, so print() the answer.',
    "Anything saved to /workspace/out/ is attached to your reply (up to 10 files, 10 MB each, 25 MB in all), e.g. plt.savefig('out/chart.png'); out/ is emptied before every run.",
    'Each run is a fresh process (variables do not carry over), but files in /workspace persist between runs and `pip install` works, within a disk limit (going over it kills the run and wipes /workspace).',
    'Pass reset_workspace: true to wipe /workspace (saved files and installs) before the run, only when leftovers from earlier runs get in the way or look tampered with.',
    'The sandbox has internet access but no secrets, and it cannot read or post Discord messages; its clock is Eastern time.',
    "Files people uploaded show up in the chat as [attachment: name (size) link] or [image: name link]: to work on one, download it from that link first (curl -L -o file '<link>', or requests). Discord's links expire after about a day, so an older one may be dead.",
    `Runs are cut off after ${formatDuration(runLimitSeconds)}, and everyone waits on your reply meanwhile; timeout_seconds only cuts a run shorter (when a quick failure beats a long hang).`,
  ].join(' ');
}

export function createRunCodeTool(opts: RunCodeToolOptions = {}): ToolDefinition {
  const runLimit = () => clampRunLimit(opts.defaultTimeoutSeconds ?? config.sandbox.timeoutSeconds);
  return {
    name: 'run_code',
    // A getter: config is read when the provider builds its tool list (after .env is loaded), not at import.
    get description() {
      return describeTool(runLimit());
    },
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: [...SANDBOX_LANGUAGES] },
        code: { type: 'string', description: 'The complete program. Print the results you need.' },
        timeout_seconds: {
          type: 'number',
          description:
            'Optional, in seconds: stops this run sooner than the usual limit. Leave it out normally; it can never make a run longer.',
        },
        reset_workspace: {
          type: 'boolean',
          description:
            'Optional. true wipes /workspace (files and pip/npm installs from earlier runs) before this run. Leave it off normally: files persist on purpose.',
        },
      },
      required: ['language', 'code'],
      additionalProperties: false,
    },
    isEnabled: () => Boolean(opts.url ?? config.sandbox.url),
    handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
      const language = parseLanguage(args.language);
      if (!language) return `Unsupported language "${String(args.language)}". Use python, bash or node.`;
      const code = typeof args.code === 'string' ? args.code : '';
      if (!code.trim()) return 'No code to run.';
      if (code.length > MAX_CODE_CHARS) {
        return `That program is too long (${code.length} characters; the limit is ${MAX_CODE_CHARS}). Load big data from a URL or a file in /workspace instead of inlining it.`;
      }
      const timeoutSeconds = parseTimeoutSeconds(args.timeout_seconds, runLimit());
      const resetWorkspace = parseFlag(args.reset_workspace);

      const outcome = await runInSandbox({ language, code, timeoutSeconds, resetWorkspace }, opts);
      if (!outcome.ok) return describeFailure(outcome);

      const { result } = outcome;
      const files = attachFiles(ctx.turn, result.files);
      logger.info(
        `run_code: channel=${ctx.channelId} language=${language} exit=${result.exit_code} timed_out=${result.timed_out} duration_ms=${result.duration_ms} files=${files.attached.length}${resetWorkspace ? ` reset=${result.workspace_reset}` : ''}`,
      );
      return formatRunResult(result, files, resetWorkspace);
    },
  };
}

export const sandboxTools: ToolDefinition[] = [createRunCodeTool()];
