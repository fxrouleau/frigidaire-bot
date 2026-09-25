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
    });
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
