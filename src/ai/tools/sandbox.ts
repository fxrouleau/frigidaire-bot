// run_code: execute code in the sidecar sandbox container (only offered when SANDBOX_URL is set).
//
// Why a sidecar instead of letting the bot run commands in its own container: that container holds the
// Discord token and the OpenRouter key, and the model reads arbitrary chat messages and web pages. One
// prompt-injected command could exfiltrate both. The sidecar (sandbox/server.py) holds no secrets, so the
// worst a hijacked run can do is burn its CPU quota or scribble in its own /workspace.
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

/** The sidecar clamps every run to this; asking for more is pointless. */
export const MAX_RUN_TIMEOUT_SECONDS = 60;
// How long a run may sit behind another one in the sidecar's queue (its SANDBOX_QUEUE_WAIT_SECONDS default),
// plus slack for the round trip and the sidecar's post-run cleanup. The HTTP timeout covers all three.
const QUEUE_GRACE_SECONDS = 30;
const TRANSPORT_GRACE_SECONDS = 10;
// The sidecar refuses code over 256 KB; anything near that is data that belongs in a file or a URL.
const MAX_CODE_CHARS = 100_000;
// What the model sees of each stream. The sidecar already caps them at 16 KB, but every tool result stays
// in the conversation for the rest of the window, so the model gets a tighter cut.
const MODEL_STDOUT_CHARS = 4000;
const MODEL_STDERR_CHARS = 2000;
// Discord allows 10 attachments per message; 8 MiB keeps the reply under an unboosted server's upload cap.
const MAX_TURN_FILES = 10;
const MAX_TURN_FILE_BYTES = 8 * 1024 * 1024;

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

export type SandboxOutcome =
  | { ok: true; result: SandboxRunResult }
  | { ok: false; kind: SandboxFailureKind; detail: string };

export type SandboxRunRequest = { language: SandboxLanguage; code: string; timeoutSeconds: number };

export type SandboxClientOptions = {
  /** Defaults to SANDBOX_URL. */
  url?: string;
  /** Defaults to SANDBOX_TOKEN. */
  token?: string;
  fetch?: typeof globalThis.fetch;
};

export type RunCodeToolOptions = SandboxClientOptions & {
  /** Defaults to SANDBOX_TIMEOUT_SECONDS. */
  defaultTimeoutSeconds?: number;
};

export function parseLanguage(raw: unknown): SandboxLanguage | undefined {
  if (typeof raw !== 'string') return undefined;
  return LANGUAGE_ALIASES[raw.trim().toLowerCase()];
}

function parseTimeoutSeconds(raw: unknown, fallback: number): number {
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(MAX_RUN_TIMEOUT_SECONDS, Math.max(1, Math.round(value)));
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
  };
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.error === 'string') return body.error;
  } catch {
    // Not JSON (a proxy's error page, say): the status code is all there is.
  }
  return `HTTP ${response.status}`;
}

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // undici reports "fetch failed" with the useful part (ECONNREFUSED, ENOTFOUND, …) in `cause`.
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
  const fetchImpl = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
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
    const detail = await readErrorDetail(response);
    if (response.status === 401 || response.status === 403) return { ok: false, kind: 'unauthorized', detail };
    if (response.status === 429 || response.status === 503) return { ok: false, kind: 'busy', detail };
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
    if (otherBytes + attachment.length > MAX_TURN_FILE_BYTES) {
      report.skipped.push({ name, reason: 'the reply would go over the 8 MB attachment limit' });
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
export function formatRunResult(result: SandboxRunResult, files: AttachReport): string {
  const seconds = (result.duration_ms / 1000).toFixed(1);
  const lines: string[] = [];
  if (result.timed_out) {
    lines.push(`Timed out after ${seconds} s and was killed; output so far is below.`);
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
  return lines.join('\n');
}

/** What the model hears when nothing ran; failures that need the owner's attention are also logged. */
function describeFailure(outcome: Extract<SandboxOutcome, { ok: false }>): string {
  switch (outcome.kind) {
    case 'busy':
      logger.warn(`run_code: sandbox busy (${outcome.detail})`);
      return 'The sandbox is busy with another run, so nothing ran. Try again in a moment.';
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
      return "The code sandbox isn't working right now, so nothing ran. Say so, or work it out by hand and say that's what you did; don't present a guess as a computed result.";
    }
  }
}

function describeTool(defaultTimeoutSeconds: number): string {
  return [
    'Run a short program on your own sandbox computer and get its output.',
    "Use it for any arithmetic you'd otherwise eyeball (bill splits, tips, unit or currency conversions, date and time math), data crunching, simulations, and making charts or files.",
    'Languages: python (numpy, pandas, matplotlib, sympy, requests preinstalled), bash (curl, jq, bc) or node.',
    'Only stdout/stderr come back, so print() the answer.',
    "Anything saved to /workspace/out/ is attached to your reply (up to 5 files, 8 MB), e.g. plt.savefig('out/chart.png'); out/ is emptied before every run.",
    'Each run is a fresh process (variables do not carry over), but files in /workspace persist between runs and `pip install` works.',
    'The sandbox has internet access but no secrets and no Discord access; its clock is Eastern time.',
    `Runs are killed after ${defaultTimeoutSeconds} s unless you pass timeout_seconds (max ${MAX_RUN_TIMEOUT_SECONDS}).`,
  ].join(' ');
}

export function createRunCodeTool(opts: RunCodeToolOptions = {}): ToolDefinition {
  const defaultTimeout = () => opts.defaultTimeoutSeconds ?? config.sandbox.timeoutSeconds;
  return {
    name: 'run_code',
    // A getter: config is read when the provider builds its tool list (after .env is loaded), not at import.
    get description() {
      return describeTool(defaultTimeout());
    },
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: [...SANDBOX_LANGUAGES] },
        code: { type: 'string', description: 'The complete program. Print the results you need.' },
        timeout_seconds: {
          type: 'number',
          description: `Optional run time limit in seconds, 1-${MAX_RUN_TIMEOUT_SECONDS}. Raise it only for slow work like pip installs or big downloads.`,
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
      const timeoutSeconds = parseTimeoutSeconds(args.timeout_seconds, defaultTimeout());

      const outcome = await runInSandbox({ language, code, timeoutSeconds }, opts);
      if (!outcome.ok) return describeFailure(outcome);

      const { result } = outcome;
      const files = attachFiles(ctx.turn, result.files);
      logger.info(
        `run_code: channel=${ctx.channelId} language=${language} exit=${result.exit_code} timed_out=${result.timed_out} duration_ms=${result.duration_ms} files=${files.attached.length}`,
      );
      return formatRunResult(result, files);
    },
  };
}

export const sandboxTools: ToolDefinition[] = [createRunCodeTool()];
