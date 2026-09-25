import { describe, expect, it } from 'vitest';
import { createFakeGitHub } from '../test-support/fakeGitHub';
import { GitHubApiError, GitHubClient } from './client';

const TOKEN = 'fake-token-for-tests';

function clientFor(fake = createFakeGitHub(), extra: { maxPages?: number } = {}) {
  return { fake, client: new GitHubClient({ token: TOKEN, repo: 'owner/repo', fetch: fake.fetch, ...extra }) };
}

async function captureError(promise: Promise<unknown>): Promise<GitHubApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GitHubApiError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('GitHubClient requests', () => {
  it('sends the token, pinned API version, JSON content type and a user agent to repo-scoped URLs', async () => {
    const { fake, client } = clientFor();
    await client.createIssue({ title: 'Add polls', body: 'body', labels: ['feature-request'] });

    const [request] = fake.requests;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/repos/owner/repo/issues');
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.headers['x-github-api-version']).toBe('2026-03-10');
    expect(request.headers.accept).toBe('application/vnd.github+json');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['user-agent']).toBeTruthy();
    expect(request.body).toEqual({ title: 'Add polls', body: 'body', labels: ['feature-request'] });
  });

  it('parses a created issue', async () => {
    const { client } = clientFor(createFakeGitHub({ issues: [{ number: 4, title: 'older', labels: [] }] }));
    const issue = await client.createIssue({ title: 'Add polls', body: 'b', labels: ['feature-request'] });
    expect(issue).toEqual({
      number: 5,
      title: 'Add polls',
      htmlUrl: 'https://github.com/owner/repo/issues/5',
      labels: ['feature-request'],
      state: 'open',
      stateReason: undefined,
      closedAt: undefined,
      body: 'b',
      locked: false,
      isPullRequest: false,
    });
  });

  it('parses state, state_reason, closed_at, lock and a missing body', async () => {
    const { client } = clientFor(
      createFakeGitHub({
        issues: [
          {
            number: 3,
            title: 'Polls',
            labels: [],
            state: 'closed',
            stateReason: 'not_planned',
            closedAt: '2026-08-01T12:00:00Z',
            locked: true,
          },
        ],
      }),
    );
    expect(await client.getIssue(3)).toMatchObject({
      state: 'closed',
      stateReason: 'not_planned',
      closedAt: Date.parse('2026-08-01T12:00:00Z'),
      locked: true,
      body: '',
    });
  });
});

describe('GitHubClient.searchIssues', () => {
  it('searches this repo’s issues only, with the requested search type', async () => {
    const { fake, client } = clientFor(
      createFakeGitHub({
        issues: [
          { number: 1, title: 'Reminder command', labels: [], body: 'remind me later' },
          { number: 2, title: 'Reminder PR', labels: [], isPullRequest: true },
          { number: 3, title: 'Weather', labels: [] },
        ],
      }),
    );
    const result = await client.searchIssues('reminder command', { searchType: 'hybrid', perPage: 5 });

    expect(result.issues.map((i) => i.number)).toEqual([1]);
    expect(result.searchType).toBe('hybrid');
    expect(result.fallbackReasons).toEqual([]);
    const [request] = fake.requests;
    expect(request.path).toBe('/search/issues');
    expect(request.query.get('q')).toBe('repo:owner/repo is:issue reminder command');
    expect(request.query.get('search_type')).toBe('hybrid');
    expect(request.query.get('per_page')).toBe('5');
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('sends no search_type for a lexical search and reports GitHub’s fallback reasons', async () => {
    const { fake, client } = clientFor(createFakeGitHub({ searchFallbackReasons: ['service_unavailable'] }));
    await client.searchIssues('polls');
    expect(fake.requests[0].query.has('search_type')).toBe(false);
    expect(fake.requests[0].query.get('per_page')).toBe('10');

    const result = await client.searchIssues('polls', { searchType: 'hybrid' });
    expect(result).toEqual({ issues: [], searchType: 'lexical', fallbackReasons: ['service_unavailable'] });
  });

  it('drops pull requests even when the search returns them', async () => {
    const client = new GitHubClient({
      token: TOKEN,
      repo: 'owner/repo',
      fetch: async () =>
        new Response(
          JSON.stringify({
            total_count: 2,
            items: [
              { number: 1, title: 'a', html_url: 'u1', state: 'open' },
              { number: 2, title: 'b', html_url: 'u2', state: 'open', pull_request: { url: 'x' } },
            ],
          }),
          { status: 200 },
        ),
    });
    expect((await client.searchIssues('a')).issues.map((i) => i.number)).toEqual([1]);
  });

  it('rejects a result without items as an invalid response', async () => {
    const client = new GitHubClient({
      token: TOKEN,
      repo: 'owner/repo',
      fetch: async () => new Response(JSON.stringify({ total_count: 0 }), { status: 200 }),
    });
    expect((await captureError(client.searchIssues('a'))).kind).toBe('invalid_response');
  });
});

describe('GitHubClient.getIssue', () => {
  it('returns the issue, and pull requests flagged as such', async () => {
    const { client } = clientFor(
      createFakeGitHub({
        issues: [
          { number: 1, title: 'Polls', labels: [], body: 'Let us vote' },
          { number: 2, title: 'Fix', labels: [], isPullRequest: true },
        ],
      }),
    );
    expect(await client.getIssue(1)).toMatchObject({ number: 1, title: 'Polls', body: 'Let us vote', isPullRequest: false });
    expect(await client.getIssue(2)).toMatchObject({ number: 2, isPullRequest: true });
  });

  it('is undefined for a missing (404), deleted (410) or transferred issue', async () => {
    const fake = createFakeGitHub({
      issues: [{ number: 5, title: 'Moved', labels: [], transferredTo: 'someone/else' }],
      failures: [{ method: 'GET', path: '/issues/6', status: 410, body: { message: 'This issue was deleted' } }],
    });
    const { client } = clientFor(fake);
    expect(await client.getIssue(4)).toBeUndefined();
    expect(await client.getIssue(5)).toBeUndefined();
    expect(await client.getIssue(6)).toBeUndefined();
  });

  it('still throws the errors that are not about the issue', async () => {
    const { client } = clientFor(createFakeGitHub({ failures: [{ status: 401, body: { message: 'Bad credentials' } }] }));
    expect((await captureError(client.getIssue(1))).kind).toBe('auth');
  });
});

describe('GitHubClient.createComment', () => {
  it('posts the body to the issue’s comments and returns the comment link', async () => {
    const { fake, client } = clientFor(createFakeGitHub({ issues: [{ number: 7, title: 'Polls', labels: [] }] }));
    const comment = await client.createComment(7, '+1 from **Jason**');

    expect(comment.htmlUrl).toMatch(/^https:\/\/github\.com\/owner\/repo\/issues\/7#issuecomment-\d+$/);
    expect(fake.requests[0]).toMatchObject({ method: 'POST', path: '/repos/owner/repo/issues/7/comments' });
    expect(fake.requests[0].body).toEqual({ body: '+1 from **Jason**' });
    expect(fake.comments).toEqual([{ issueNumber: 7, body: '+1 from **Jason**', htmlUrl: comment.htmlUrl }]);
  });

  it('classifies a refused comment (locked issue) as forbidden', async () => {
    const { client } = clientFor(createFakeGitHub({ issues: [{ number: 7, title: 'Polls', labels: [], locked: true }] }));
    expect((await captureError(client.createComment(7, 'x'))).kind).toBe('forbidden');
  });
});

describe('GitHubClient.listOpenIssues', () => {
  it('filters out pull requests, which the issues endpoint also returns', async () => {
    const { client } = clientFor(
      createFakeGitHub({
        issues: [
          { number: 1, title: 'Add polls', labels: ['feature-request'] },
          { number: 2, title: 'Fix everything', labels: [], isPullRequest: true },
        ],
      }),
    );
    const issues = await client.listOpenIssues();
    expect(issues.map((i) => i.number)).toEqual([1]);
    expect(issues[0].labels).toEqual(['feature-request']);
  });

  it('asks for open issues 100 at a time and follows pages until a short one', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}`, labels: [] }));
    const { fake, client } = clientFor(createFakeGitHub({ issues: many }));
    const issues = await client.listOpenIssues();

    expect(issues).toHaveLength(150);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0].query.get('state')).toBe('open');
    expect(fake.requests[0].query.get('per_page')).toBe('100');
    expect(fake.requests.map((r) => r.query.get('page'))).toEqual(['1', '2']);
  });

  it('stops at maxPages', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}`, labels: [] }));
    const { fake, client } = clientFor(createFakeGitHub({ issues: many }), { maxPages: 1 });
    expect(await client.listOpenIssues()).toHaveLength(100);
    expect(fake.requests).toHaveLength(1);
  });

  it('rejects a non-array body as an invalid response', async () => {
    const client = new GitHubClient({
      token: TOKEN,
      repo: 'owner/repo',
      fetch: async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    });
    expect((await captureError(client.listOpenIssues())).kind).toBe('invalid_response');
  });
});

describe('GitHubClient.ensureLabel', () => {
  it('creates a missing label and reports an existing one (422 already_exists) as fine', async () => {
    const { fake, client } = clientFor(createFakeGitHub({ labels: ['from-discord'] }));
    const spec = { color: 'ffffff', description: 'd' };
    expect(await client.ensureLabel({ name: 'feature-request', ...spec })).toBe('created');
    expect(await client.ensureLabel({ name: 'from-discord', ...spec })).toBe('exists');
    expect(fake.requests[0].body).toEqual({ name: 'feature-request', color: 'ffffff', description: 'd' });
  });

  it('still throws other validation errors', async () => {
    const fake = createFakeGitHub({
      failures: [
        { path: '/labels', status: 422, body: { message: 'Validation Failed', errors: [{ code: 'invalid' }] } },
      ],
    });
    const { client } = clientFor(fake);
    const error = await captureError(client.ensureLabel({ name: 'x', color: 'zzz', description: '' }));
    expect(error.kind).toBe('validation');
    expect(error.validationCodes).toEqual(['invalid']);
  });
});

describe('GitHubClient error classification', () => {
  const cases: Array<{ name: string; failure: Parameters<ReturnType<typeof createFakeGitHub>['fail']>[0]; kind: string }> =
    [
      { name: '401 → auth', failure: { status: 401, body: { message: 'Bad credentials' } }, kind: 'auth' },
      {
        name: '403 without rate-limit signals → forbidden',
        failure: { status: 403, body: { message: 'Resource not accessible by personal access token' } },
        kind: 'forbidden',
      },
      {
        name: '403 with x-ratelimit-remaining: 0 → rate_limited',
        failure: {
          status: 403,
          body: { message: 'API rate limit exceeded' },
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) },
        },
        kind: 'rate_limited',
      },
      {
        name: '403 secondary rate limit with retry-after → rate_limited',
        failure: {
          status: 403,
          body: { message: 'You have exceeded a secondary rate limit' },
          headers: { 'retry-after': '120' },
        },
        kind: 'rate_limited',
      },
      { name: '429 → rate_limited', failure: { status: 429, body: { message: 'Too Many Requests' } }, kind: 'rate_limited' },
      { name: '404 → not_found', failure: { status: 404, body: { message: 'Not Found' } }, kind: 'not_found' },
      { name: '410 → disabled', failure: { status: 410, body: { message: 'Issues are disabled' } }, kind: 'disabled' },
      { name: '422 → validation', failure: { status: 422, body: { message: 'Validation Failed' } }, kind: 'validation' },
      { name: '502 → server', failure: { status: 502, body: '<html>Bad gateway</html>' }, kind: 'server' },
      { name: 'network failure → network', failure: { networkError: true }, kind: 'network' },
      { name: 'timeout → timeout', failure: { timeout: true }, kind: 'timeout' },
    ];

  for (const { name, failure, kind } of cases) {
    it(name, async () => {
      const fake = createFakeGitHub({ failures: [failure] });
      const { client } = clientFor(fake);
      const error = await captureError(client.createIssue({ title: 't', body: 'b', labels: [] }));
      expect(error.kind).toBe(kind);
      // The token never leaks into an error message (they get logged).
      expect(error.message).not.toContain(TOKEN);
    });
  }

  it('reports how long a rate limit lasts', async () => {
    const fake = createFakeGitHub({ failures: [{ status: 403, headers: { 'retry-after': '90' } }] });
    const { client } = clientFor(fake);
    const error = await captureError(client.listOpenIssues());
    expect(error.retryAfterSeconds).toBe(90);
  });

  it('includes GitHub’s own message for the logs', async () => {
    const fake = createFakeGitHub({ failures: [{ status: 401, body: { message: 'Bad credentials' } }] });
    const { client } = clientFor(fake);
    const error = await captureError(client.listOpenIssues());
    expect(error.status).toBe(401);
    expect(error.message).toContain('Bad credentials');
  });

  it('aborts a request that hangs past the timeout', async () => {
    const client = new GitHubClient({
      token: TOKEN,
      repo: 'owner/repo',
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    expect((await captureError(client.listOpenIssues())).kind).toBe('timeout');
  });
});
