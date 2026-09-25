// An in-memory stand-in for the three GitHub REST endpoints the feature-request flow uses (list open
// issues, create an issue, create a label), served through an injected fetch. Response shapes follow
// what api.github.com returns (issue objects with `html_url`, `labels: [{ name }]`, and a
// `pull_request` key on pull requests; 422 `already_exists` for a duplicate label). Failures can be
// scripted per method/path to exercise every error branch.
import type { FetchLike } from '../github/client';

export type RecordedRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
};

export type FakeIssue = { number: number; title: string; labels: string[]; isPullRequest?: boolean };

export type ScriptedFailure = {
  method?: 'GET' | 'POST';
  /** Matched as a substring of the request path, e.g. '/issues' or '/labels'. */
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

export type FakeGitHub = {
  fetch: FetchLike;
  requests: RecordedRequest[];
  issues: FakeIssue[];
  labels: Set<string>;
  fail(failure: ScriptedFailure): void;
};

export function createFakeGitHub(
  opts: { repo?: string; issues?: FakeIssue[]; labels?: string[]; failures?: ScriptedFailure[] } = {},
): FakeGitHub {
  const repo = opts.repo ?? 'owner/repo';
  const issues: FakeIssue[] = [...(opts.issues ?? [])];
  const labels = new Set(opts.labels ?? []);
  const failures: ScriptedFailure[] = [...(opts.failures ?? [])];
  const requests: RecordedRequest[] = [];

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const toApiIssue = (issue: FakeIssue) => ({
    number: issue.number,
    title: issue.title,
    state: 'open',
    html_url: `https://github.com/${repo}/${issue.isPullRequest ? 'pull' : 'issues'}/${issue.number}`,
    labels: issue.labels.map((name) => ({ name })),
    ...(issue.isPullRequest ? { pull_request: { url: 'https://api.github.com/pr' } } : {}),
  });

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

    const prefix = `/repos/${repo}`;
    if (!url.pathname.startsWith(prefix)) return json(404, { message: 'Not Found' });
    const route = url.pathname.slice(prefix.length);

    if (method === 'GET' && route === '/issues') {
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      const open = [...issues].sort((a, b) => b.number - a.number);
      return json(200, open.slice((page - 1) * perPage, page * perPage).map(toApiIssue));
    }
    if (method === 'POST' && route === '/issues') {
      const payload = body as { title: string; labels?: string[] };
      const issue: FakeIssue = {
        number: issues.reduce((max, i) => Math.max(max, i.number), 0) + 1,
        title: payload.title,
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

  return { fetch, requests, issues, labels, fail: (failure) => failures.push(failure) };
}
