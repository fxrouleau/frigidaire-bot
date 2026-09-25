// Minimal GitHub REST client for the one thing the bot does on GitHub: filing member feature requests
// as issues on its own repo (list/search/read issues for duplicate detection, create labels, create
// issues, and add a member's +1 comment to an existing request).
//
// Plain fetch instead of an SDK: a handful of endpoints do not justify a dependency, and an injected fetch
// keeps the tests hermetic. The token is a fine-grained PAT scoped to this one repo with Issues read/write
// (every repo endpoint here is covered by that single permission; issue search only needs read access to
// the repo). It is only ever sent in the Authorization header; error messages and logs carry GitHub's
// status and message, never the token.
import { logger } from '../logger';

const API_BASE = 'https://api.github.com';
// Pinned so a future default-version bump cannot silently change response shapes. 2026-03-10's breaking
// changes (singular `assignee`, `merge_commit_sha`, `rate`) touch nothing this client reads.
const API_VERSION = '2026-03-10';
const USER_AGENT = 'frigidaire-bot';
const DEFAULT_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Why a GitHub call failed, in the terms a caller acts on:
 * - auth: the token is invalid or expired (401)
 * - forbidden: the token is valid but lacks the permission (403 without a rate-limit signal)
 * - not_found: the repo does not exist or the token cannot see it (404)
 * - disabled: issues are turned off on the repo (410)
 * - rate_limited: primary or secondary rate limit (403/429 with a rate-limit signal)
 * - validation: GitHub rejected the payload (422)
 * - server / network / timeout: transient; worth retrying later
 * - invalid_response: a 2xx whose body is not what the endpoint documents
 */
export type GitHubErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'disabled'
  | 'rate_limited'
  | 'validation'
  | 'server'
  | 'network'
  | 'timeout'
  | 'invalid_response';

export class GitHubApiError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    message: string,
    readonly status?: number,
    /** Seconds until GitHub accepts requests again, when it said so (rate limits only). */
    readonly retryAfterSeconds?: number,
    /** GitHub's machine-readable validation codes (422 only), e.g. `already_exists`. */
    readonly validationCodes: string[] = [],
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export type GitHubIssue = {
  number: number;
  title: string;
  htmlUrl: string;
  labels: string[];
  state: 'open' | 'closed';
  /** GitHub's `state_reason`: `completed`, `not_planned`, `duplicate`, `reopened`, or undefined (null). */
  stateReason?: string;
  /** Epoch ms, for closed issues. */
  closedAt?: number;
  /** The raw markdown body ('' when there is none). Untrusted: anyone can open issues on a public repo. */
  body: string;
  /** A locked issue only takes comments from collaborators; the bot does not add +1s to one. */
  locked: boolean;
  /** The issues endpoints also return pull requests (they carry a `pull_request` key). */
  isPullRequest: boolean;
};

export type IssueSearchType = 'lexical' | 'hybrid' | 'semantic';

/** What GET /search/issues found, and which kind of search GitHub actually ran. */
export type IssueSearchResult = {
  issues: GitHubIssue[];
  /** `hybrid`/`semantic` as asked, or `lexical` when GitHub fell back (see fallbackReasons). */
  searchType?: string;
  fallbackReasons: string[];
};

export type CreateIssueInput = { title: string; body: string; labels: string[] };
export type LabelSpec = { name: string; color: string; description: string };

/** The subset of the client the feature-request service uses (fakeable in tests). */
export interface GitHubIssuesApi {
  readonly repo: string;
  listOpenIssues(): Promise<GitHubIssue[]>;
  /** Issues (never pull requests) in this repo matching `terms`, in GitHub's relevance order. */
  searchIssues(terms: string, opts?: SearchOptions): Promise<IssueSearchResult>;
  /** The issue or pull request with this number, or undefined when it does not exist in this repo. */
  getIssue(issueNumber: number): Promise<GitHubIssue | undefined>;
  createIssue(input: CreateIssueInput): Promise<GitHubIssue>;
  createComment(issueNumber: number, body: string): Promise<{ htmlUrl: string }>;
  ensureLabel(label: LabelSpec): Promise<'created' | 'exists'>;
}

export type SearchOptions = { searchType?: IssueSearchType; perPage?: number };

export type GitHubClientOptions = {
  token: string;
  /** `owner/name`. */
  repo: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Open issues listed at most PAGE_SIZE × maxPages; a hobby repo never gets near it. */
  maxPages?: number;
};

type ErrorBody = { message?: unknown; errors?: unknown };

export class GitHubClient implements GitHubIssuesApi {
  readonly repo: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxPages: number;

  constructor(opts: GitHubClientOptions) {
    this.repo = opts.repo;
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPages = opts.maxPages ?? 3;
  }

  /** Every open issue (pull requests, which the issues endpoint also returns, are filtered out). */
  async listOpenIssues(): Promise<GitHubIssue[]> {
    const issues: GitHubIssue[] = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const rows = await this.request('GET', this.repoPath(`/issues?state=open&per_page=${PAGE_SIZE}&page=${page}`));
      if (!Array.isArray(rows)) {
        throw new GitHubApiError('invalid_response', 'GitHub returned a non-array issue list');
      }
      for (const row of rows) {
        const issue = parseIssue(row);
        if (issue && !issue.isPullRequest) issues.push(issue);
      }
      if (rows.length < PAGE_SIZE) break;
    }
    return issues;
  }

  /**
   * GET /search/issues scoped to this repo's issues. `hybrid` (semantic + lexical) also finds a request
   * worded differently ("polls" vs "voting"); GitHub falls back to lexical by itself when it cannot run
   * it, and says so. Hybrid/semantic searches have their own budget of 10 requests a minute (lexical: 30).
   */
  async searchIssues(terms: string, opts: SearchOptions = {}): Promise<IssueSearchResult> {
    // `is:issue` keeps pull requests out, and semantic search needs it (otherwise: `non_issue_target`).
    const params = new URLSearchParams({
      q: `repo:${this.repo} is:issue ${terms}`,
      per_page: String(Math.min(Math.max(opts.perPage ?? 10, 1), 100)),
    });
    if (opts.searchType && opts.searchType !== 'lexical') params.set('search_type', opts.searchType);
    const response = await this.request('GET', `/search/issues?${params}`);
    if (!isRecord(response) || !Array.isArray(response.items)) {
      throw new GitHubApiError('invalid_response', 'GitHub returned a search result without items');
    }
    const fallback = response.lexical_fallback_reason;
    return {
      issues: response.items.flatMap((row) => {
        const issue = parseIssue(row);
        return issue && !issue.isPullRequest ? [issue] : [];
      }),
      searchType: typeof response.search_type === 'string' ? response.search_type : undefined,
      fallbackReasons: Array.isArray(fallback)
        ? fallback.filter((reason): reason is string => typeof reason === 'string')
        : [],
    };
  }

  /**
   * One issue (or pull request) by number. undefined when there is no such issue here: 404 (it never
   * existed), 410 (deleted), or a transfer to another repo (GitHub answers 301, fetch follows it, and the
   * issue that comes back belongs to the other repo).
   */
  async getIssue(issueNumber: number): Promise<GitHubIssue | undefined> {
    let raw: unknown;
    try {
      raw = await this.request('GET', this.repoPath(`/issues/${issueNumber}`));
    } catch (error) {
      if (error instanceof GitHubApiError && (error.status === 404 || error.status === 410)) return undefined;
      throw error;
    }
    const issue = parseIssue(raw);
    if (!issue) {
      throw new GitHubApiError('invalid_response', `GitHub returned no number/url for issue #${issueNumber}`);
    }
    const repositoryUrl = isRecord(raw) && typeof raw.repository_url === 'string' ? raw.repository_url : undefined;
    if (repositoryUrl && !repositoryUrl.toLowerCase().endsWith(`/repos/${this.repo.toLowerCase()}`)) return undefined;
    return issue;
  }

  async createIssue(input: CreateIssueInput): Promise<GitHubIssue> {
    const created = parseIssue(await this.request('POST', this.repoPath('/issues'), input));
    if (!created) {
      throw new GitHubApiError('invalid_response', 'GitHub created an issue but returned no number/url');
    }
    return created;
  }

  async createComment(issueNumber: number, body: string): Promise<{ htmlUrl: string }> {
    const created = await this.request('POST', this.repoPath(`/issues/${issueNumber}/comments`), { body });
    if (!isRecord(created) || typeof created.html_url !== 'string') {
      throw new GitHubApiError('invalid_response', 'GitHub created a comment but returned no url');
    }
    return { htmlUrl: created.html_url };
  }

  /** Creates the label, or reports that it already exists (GitHub answers 422 `already_exists`). */
  async ensureLabel(label: LabelSpec): Promise<'created' | 'exists'> {
    try {
      await this.request('POST', this.repoPath('/labels'), label);
      return 'created';
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        error.kind === 'validation' &&
        error.validationCodes.includes('already_exists')
      ) {
        return 'exists';
      }
      throw error;
    }
  }

  private repoPath(path: string): string {
    return `/repos/${this.repo}${path}`;
  }

  /** `path` is relative to the API root; repo endpoints build theirs with repoPath(). */
  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const url = `${API_BASE}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'x-github-api-version': API_VERSION,
          'user-agent': USER_AGENT,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new GitHubApiError('timeout', `GitHub ${method} ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw new GitHubApiError(
        'network',
        `GitHub ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new GitHubApiError('invalid_response', `GitHub ${method} ${path} returned invalid JSON`, response.status);
      }
    }
    throw await toApiError(method, path, response);
  }
}

async function toApiError(method: string, path: string, response: Response): Promise<GitHubApiError> {
  let parsed: ErrorBody = {};
  try {
    const json: unknown = await response.json();
    if (isRecord(json)) parsed = json;
  } catch {
    // Non-JSON error bodies (an HTML 502 from a proxy) still classify by status alone.
  }
  const githubMessage = typeof parsed.message === 'string' ? parsed.message : response.statusText;
  const message = `GitHub ${method} ${path} → ${response.status}: ${githubMessage}`;
  const status = response.status;

  if (status === 401) return new GitHubApiError('auth', message, status);
  if (status === 403 || status === 429) {
    const retryAfter = retryAfterSeconds(response);
    const limited =
      status === 429 ||
      retryAfter !== undefined ||
      response.headers.get('x-ratelimit-remaining') === '0' ||
      /rate limit/i.test(githubMessage);
    return limited
      ? new GitHubApiError('rate_limited', message, status, retryAfter)
      : new GitHubApiError('forbidden', message, status);
  }
  if (status === 404) return new GitHubApiError('not_found', message, status);
  if (status === 410) return new GitHubApiError('disabled', message, status);
  if (status === 422) return new GitHubApiError('validation', message, status, undefined, validationCodes(parsed));
  if (status >= 500) return new GitHubApiError('server', message, status);
  logger.warn(`github: unexpected status ${status} for ${method} ${path}`);
  return new GitHubApiError('invalid_response', message, status);
}

/**
 * GitHub's documented rate-limit signals: `retry-after` (seconds) on secondary limits, and
 * `x-ratelimit-reset` (epoch seconds) once the primary budget is spent.
 */
function retryAfterSeconds(response: Response): number | undefined {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - Date.now() / 1000));
  }
  return undefined;
}

function validationCodes(body: ErrorBody): string[] {
  if (!Array.isArray(body.errors)) return [];
  return body.errors.flatMap((entry) => (isRecord(entry) && typeof entry.code === 'string' ? [entry.code] : []));
}

function parseIssue(raw: unknown): GitHubIssue | undefined {
  if (!isRecord(raw)) return undefined;
  const { number, title, html_url: htmlUrl, labels, state_reason: stateReason, closed_at: closedAt, body } = raw;
  if (typeof number !== 'number' || typeof title !== 'string' || typeof htmlUrl !== 'string') return undefined;
  const closedMs = typeof closedAt === 'string' ? Date.parse(closedAt) : Number.NaN;
  return {
    number,
    title,
    htmlUrl,
    labels: Array.isArray(labels)
      ? labels.flatMap((label) =>
          typeof label === 'string' ? [label] : isRecord(label) && typeof label.name === 'string' ? [label.name] : [],
        )
      : [],
    state: raw.state === 'closed' ? 'closed' : 'open',
    stateReason: typeof stateReason === 'string' ? stateReason : undefined,
    closedAt: Number.isFinite(closedMs) ? closedMs : undefined,
    body: typeof body === 'string' ? body : '',
    locked: raw.locked === true,
    isPullRequest: raw.pull_request !== undefined && raw.pull_request !== null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
