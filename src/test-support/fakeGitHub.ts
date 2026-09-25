// An in-memory stand-in for the GitHub REST endpoints the feature-request flow uses (list open issues,
// search issues, get one issue, create an issue, comment on one, create a label), served through an
// injected fetch. Response shapes follow what api.github.com returns (issue objects with `html_url`,
// `state`, `state_reason`, `closed_at`, `labels: [{ name }]`, `author_association`, and a `pull_request`
// key on pull requests;
// search results wrapped in `{ total_count, items, search_type }`; 422 `already_exists` for a duplicate
// label). Failures can be scripted per method/path to exercise every error branch.
import type { FetchLike } from '../github/client';

export type RecordedRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
};

export type FakeIssue = {
  number: number;
  title: string;
  labels: string[];
  isPullRequest?: boolean;
  body?: string;
  state?: 'open' | 'closed';
  stateReason?: 'completed' | 'not_planned' | 'duplicate' | 'reopened' | null;
  /** ISO timestamp; closed issues only. */
  closedAt?: string;
  locked?: boolean;
  /** The issue was moved to this repo (`owner/name`): GET answers with the moved issue, as after a 301. */
  transferredTo?: string;
  /**
   * GitHub's `author_association`. Default 'OWNER': the bot files with the owner's token, and most tests
   * stand for issues the owner (or the bot) opened. 'NONE' is a stranger on the public repo.
   */
  authorAssociation?: string;
};

export type FakeComment = { issueNumber: number; body: string; htmlUrl: string };

export type ScriptedFailure = {
  method?: 'GET' | 'POST';
  /** Matched as a substring of the request path, e.g. '/issues', '/search/issues' or '/labels'. */
  path?: string;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Reject the fetch itself (DNS failure, connection reset). */
  networkError?: boolean;
  /** Reject like AbortSignal.timeout() does. */
  timeout?: boolean;
  /** How many matching requests fail before the route works again (default: every one). */
  times?: number;
};

export type FakeGitHubOptions = {
  repo?: string;
  issues?: FakeIssue[];
  labels?: string[];
  failures?: ScriptedFailure[];
  /**
   * Scripted search ranking (issue numbers, best first) for a query's free-text terms, e.g. to stand in
   * for a semantic hit that shares no word with the query. Default: issues whose title or body contains
   * any term, most matched terms first.
   */
  search?: (terms: string[], issues: FakeIssue[]) => number[];
  /** When set, search answers as a hybrid search that fell back to lexical for these reasons. */
  searchFallbackReasons?: string[];
};

export type FakeGitHub = {
  fetch: FetchLike;
  requests: RecordedRequest[];
  issues: FakeIssue[];
  labels: Set<string>;
  comments: FakeComment[];
  fail(failure: ScriptedFailure): void;
};

function defaultSearch(terms: string[], issues: FakeIssue[]): number[] {
  const scored = issues.flatMap((issue) => {
    const text = `${issue.title}\n${issue.body ?? ''}`.toLowerCase();
    const hits = terms.filter((term) => text.includes(term.toLowerCase())).length;
    return hits > 0 ? [{ number: issue.number, hits }] : [];
  });
  return scored.sort((a, b) => b.hits - a.hits || b.number - a.number).map((entry) => entry.number);
}

export function createFakeGitHub(opts: FakeGitHubOptions = {}): FakeGitHub {
  const repo = opts.repo ?? 'owner/repo';
  const issues: FakeIssue[] = [...(opts.issues ?? [])];
  const labels = new Set(opts.labels ?? []);
  const failures: ScriptedFailure[] = [...(opts.failures ?? [])];
  const requests: RecordedRequest[] = [];
  const comments: FakeComment[] = [];
  const search = opts.search ?? defaultSearch;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const toApiIssue = (issue: FakeIssue) => {
    const home = issue.transferredTo ?? repo;
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      state: issue.state ?? 'open',
      state_reason: issue.stateReason ?? null,
      closed_at: issue.closedAt ?? null,
      locked: issue.locked ?? false,
      repository_url: `https://api.github.com/repos/${home}`,
      html_url: `https://github.com/${home}/${issue.isPullRequest ? 'pull' : 'issues'}/${issue.number}`,
      labels: issue.labels.map((name) => ({ name })),
      author_association: issue.authorAssociation ?? 'OWNER',
      ...(issue.isPullRequest ? { pull_request: { url: 'https://api.github.com/pr' } } : {}),
    };
  };

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ method, path: url.pathname, query: url.searchParams, headers, body });

    const failure = failures.find(
      (f) => (f.method === undefined || f.method === method) && (f.path === undefined || url.pathname.includes(f.path)),
    );
    if (failure) {
      if (failure.times !== undefined && --failure.times <= 0) failures.splice(failures.indexOf(failure), 1);
      if (failure.networkError) throw new TypeError('fetch failed');
      if (failure.timeout) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return json(failure.status ?? 500, failure.body ?? { message: 'Server Error' }, failure.headers);
    }

    if (method === 'GET' && url.pathname === '/search/issues') {
      const words = (url.searchParams.get('q') ?? '').split(/\s+/).filter(Boolean);
      const qualifiers = words.filter((word) => /^[a-z]+:/.test(word));
      if (!qualifiers.includes(`repo:${repo}`)) return json(422, { message: 'Validation Failed' });
      const terms = words.filter((word) => !/^[a-z]+:/.test(word));
      const eligible = issues.filter((issue) => !(qualifiers.includes('is:issue') && issue.isPullRequest));
      const ranked = search(terms, eligible).flatMap((number) => eligible.filter((issue) => issue.number === number));
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const requested = url.searchParams.get('search_type');
      return json(200, {
        total_count: ranked.length,
        incomplete_results: false,
        search_type: opts.searchFallbackReasons ? 'lexical' : (requested ?? 'lexical'),
        ...(opts.searchFallbackReasons ? { lexical_fallback_reason: opts.searchFallbackReasons } : {}),
        items: ranked.slice(0, perPage).map((issue) => ({ ...toApiIssue(issue), score: 1 })),
      });
    }

    const prefix = `/repos/${repo}`;
    if (!url.pathname.startsWith(prefix)) return json(404, { message: 'Not Found' });
    const route = url.pathname.slice(prefix.length);
    const single = /^\/issues\/(\d+)(\/comments)?$/.exec(route);

    if (method === 'GET' && route === '/issues') {
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      const state = url.searchParams.get('state') ?? 'open';
      const listed = issues
        .filter((issue) => state === 'all' || (issue.state ?? 'open') === state)
        .sort((a, b) => b.number - a.number);
      return json(200, listed.slice((page - 1) * perPage, page * perPage).map(toApiIssue));
    }
    if (single) {
      const issue = issues.find((candidate) => candidate.number === Number(single[1]));
      if (!issue) return json(404, { message: 'Not Found' });
      if (method === 'GET' && !single[2]) return json(200, toApiIssue(issue));
      if (method === 'POST' && single[2]) {
        if (issue.locked) return json(403, { message: 'Unable to create comment because issue is locked.' });
        const payload = body as { body: string };
        const htmlUrl = `https://github.com/${repo}/issues/${issue.number}#issuecomment-${1000 + comments.length}`;
        comments.push({ issueNumber: issue.number, body: payload.body, htmlUrl });
        return json(201, { id: 1000 + comments.length, body: payload.body, html_url: htmlUrl });
      }
    }
    if (method === 'POST' && route === '/issues') {
      const payload = body as { title: string; body?: string; labels?: string[] };
      const issue: FakeIssue = {
        number: issues.reduce((max, i) => Math.max(max, i.number), 0) + 1,
        title: payload.title,
        body: payload.body,
        labels: payload.labels ?? [],
      };
      issues.push(issue);
      return json(201, toApiIssue(issue));
    }
    if (method === 'POST' && route === '/labels') {
      const payload = body as { name: string };
      if (labels.has(payload.name)) {
        return json(422, {
          message: 'Validation Failed',
          errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }],
        });
      }
      labels.add(payload.name);
      return json(201, { name: payload.name });
    }
    return json(404, { message: 'Not Found' });
  };

  return { fetch, requests, issues, labels, comments, fail: (failure) => failures.push(failure) };
}
