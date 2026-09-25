import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotDb } from '../storage/botDb';
import { type FakeGitHub, type FakeIssue, createFakeGitHub } from '../test-support/fakeGitHub';
import { GitHubClient } from './client';
import {
  CandidateReviews,
  FROM_DISCORD_LABEL,
  type FeatureRequestInput,
  FeatureRequestService,
  type FeatureRequestServiceOptions,
  IMPLEMENT_LABEL,
  ISSUE_LABELS,
} from './featureRequests';
import type { IssueDraft } from './issueText';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const START = Date.parse('2026-09-25T15:00:00Z');

const requester = { userId: 'user-1', displayName: 'Jason', jumpUrl: 'https://discord.com/channels/g/c/m' };

function draft(title: string): IssueDraft {
  return { title, description: `Please build: ${title}`, acceptanceCriteria: [] };
}

function request(title: string, extra: Omit<FeatureRequestInput, 'draft'> = {}): FeatureRequestInput {
  return { draft: draft(title), ...extra };
}

function daysAgo(days: number): string {
  return new Date(START - days * DAY_MS).toISOString();
}

function setup(opts: Partial<FeatureRequestServiceOptions> & { fake?: FakeGitHub; issues?: FakeIssue[] } = {}) {
  const fake = opts.fake ?? createFakeGitHub({ issues: opts.issues });
  const clock = { now: START };
  const db = new BotDb(':memory:');
  const reviews = new CandidateReviews();
  const service = new FeatureRequestService({
    client: new GitHubClient({ token: 't', repo: 'owner/repo', fetch: fake.fetch }),
    maxPerDay: 3,
    maxCommentsPerDay: 10,
    closedLookbackDays: 90,
    allowedUserIds: [],
    db,
    now: () => clock.now,
    ensuredLabelRepos: new Set(),
    reviews,
    ...opts,
  });
  const rows = () => db.stmt('SELECT user_id, status, issue_number FROM feature_requests ORDER BY id').all();
  const commentRows = () =>
    db.stmt('SELECT user_id, repo, issue_number, status FROM feature_request_comments ORDER BY id').all();
  const creates = () => fake.requests.filter((r) => r.method === 'POST' && r.path === '/repos/owner/repo/issues');
  return { fake, clock, db, service, rows, commentRows, creates };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('FeatureRequestService: filing', () => {
  it('files an issue with the fixed labels, the rendered body, and records it', async () => {
    const { service, rows, creates } = setup();
    const outcome = await service.submit(request('Add polls'), requester);

    expect(outcome).toMatchObject({ kind: 'filed', issue: { number: 1, htmlUrl: 'https://github.com/owner/repo/issues/1' } });
    const [create] = creates();
    expect(create?.body).toMatchObject({ title: 'Add polls', labels: ['feature-request', 'from-discord'] });
    expect((create?.body as { body: string }).body).toContain('🤖 Filed by Frigidaire for **Jason**');
    expect(rows()).toEqual([{ user_id: 'user-1', status: 'filed', issue_number: 1 }]);
  });

  it('never applies the owner-approval label (the bot token IS the owner, so it would count as approval)', async () => {
    const { service, creates } = setup();
    await service.submit(request('Add polls'), requester);
    expect(ISSUE_LABELS).not.toContain(IMPLEMENT_LABEL);
    for (const create of creates()) {
      expect((create.body as { labels: string[] }).labels).not.toContain(IMPLEMENT_LABEL);
    }
  });

  it('ensures the labels once per repo, best-effort', async () => {
    const fake = createFakeGitHub({ labels: [FROM_DISCORD_LABEL] });
    const ensured = new Set<string>();
    const { service } = setup({ fake, ensuredLabelRepos: ensured });
    await service.submit(request('Add polls'), requester);
    await service.submit(request('Add weather'), requester);

    const labelPosts = fake.requests.filter((r) => r.path.endsWith('/labels'));
    expect(labelPosts.map((r) => (r.body as { name: string }).name).sort()).toEqual(
      ['claude-implement', 'feature-request', 'from-discord'].sort(),
    );
    expect(fake.labels.has('claude-implement')).toBe(true);
    expect(ensured.has('owner/repo')).toBe(true);
  });

  it('still files when a label cannot be created, and tries the labels again next time', async () => {
    const fake = createFakeGitHub({ failures: [{ path: '/labels', status: 403, body: { message: 'nope' }, times: 1 }] });
    const ensured = new Set<string>();
    const { service } = setup({ fake, ensuredLabelRepos: ensured });

    expect((await service.submit(request('Add polls'), requester)).kind).toBe('filed');
    expect(ensured.size).toBe(0);
    await service.submit(request('Add weather'), requester);
    expect(ensured.has('owner/repo')).toBe(true);
  });

  it('checks existing issues with a hybrid search of the title’s keywords and the open-issue list', async () => {
    const { fake, service } = setup();
    await service.submit(request('Add a remindme command'), requester);
    const search = fake.requests.find((r) => r.path === '/search/issues');
    expect(search?.query.get('q')).toBe('repo:owner/repo is:issue remindme command');
    expect(search?.query.get('search_type')).toBe('hybrid');
    expect(fake.requests.some((r) => r.path === '/repos/owner/repo/issues' && r.method === 'GET')).toBe(true);
  });

  it('stops at the first fatal error (bad token, rate limit) instead of repeating it on every call', async () => {
    const fake = createFakeGitHub({ failures: [{ status: 401, body: { message: 'Bad credentials' } }] });
    const { service, rows } = setup({ fake });
    const outcome = await service.submit(request('Add polls'), requester);

    expect(outcome.kind).toBe('github_error');
    if (outcome.kind === 'github_error') expect(outcome.error.kind).toBe('auth');
    expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(rows()).toEqual([]);

    const limited = createFakeGitHub({ failures: [{ method: 'GET', path: '/repos/owner/repo/issues', status: 429 }] });
    const second = setup({ fake: limited });
    expect((await second.service.submit(request('Add polls'), requester)).kind).toBe('github_error');
    expect(limited.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('files anyway when both the listing and the search fail transiently', async () => {
    const fake = createFakeGitHub({ failures: [{ method: 'GET', path: '/issues', status: 502 }] });
    const { service } = setup({ fake });
    expect((await service.submit(request('Add polls'), requester)).kind).toBe('filed');
  });

  it('treats a rate-limited search as a lost search, not a failed request (search has its own budget)', async () => {
    const fake = createFakeGitHub({
      issues: [{ number: 4, title: 'Anonymous polls', labels: [] }],
      failures: [{ path: '/search/issues', status: 403, body: { message: 'rate limit' }, headers: { 'retry-after': '30' } }],
    });
    const { service } = setup({ fake });
    // The open-issue listing still finds the candidate.
    const outcome = await service.submit(request('Add polls with anonymous votes'), requester);
    expect(outcome).toMatchObject({ kind: 'candidates', candidates: [{ issue: { number: 4 } }] });
    expect((await service.submit(request('Add weather'), requester)).kind).toBe('filed');
  });

  it('caps each member at maxPerDay in a rolling 24 hours; others are unaffected', async () => {
    const { clock, service } = setup({ maxPerDay: 2 });
    expect((await service.submit(request('Add polls'), requester)).kind).toBe('filed');
    clock.now += HOUR_MS;
    expect((await service.submit(request('Add weather'), requester)).kind).toBe('filed');
    clock.now += HOUR_MS;

    const limited = await service.submit(request('Add trivia'), requester);
    expect(limited).toEqual({ kind: 'daily_limit', limit: 2, nextSlotAt: new Date(START + 24 * HOUR_MS) });

    const other = await service.submit(request('Add trivia'), { ...requester, userId: 'user-2' });
    expect(other.kind).toBe('filed');

    // The first request ages out of the window exactly 24 hours after it was filed.
    clock.now = START + 24 * HOUR_MS + 1;
    expect((await service.submit(request('Add chess'), requester)).kind).toBe('filed');
  });

  it('does not count failed attempts or +1s against the filing cap', async () => {
    const fake = createFakeGitHub({
      issues: [{ number: 1, title: 'Polls', labels: [] }],
      failures: [{ method: 'POST', path: '/repos/owner/repo/issues', status: 500, times: 2 }],
    });
    const { service, rows } = setup({ fake, maxPerDay: 1 });
    expect((await service.submit(request('Add weather'), requester)).kind).toBe('github_error');
    expect((await service.submit(request('Add weather'), requester)).kind).toBe('github_error');
    expect((await service.submit(request('Add polls'), requester)).kind).toBe('duplicate');
    expect(rows()).toEqual([]);
    expect((await service.submit(request('Add weather'), requester)).kind).toBe('filed');
  });

  it('reserves the slot before the create, so parallel requests cannot exceed the cap', async () => {
    const { service } = setup({ maxPerDay: 1 });
    const outcomes = await Promise.all([
      service.submit(request('Add polls'), requester),
      service.submit(request('Add weather'), requester),
    ]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(['daily_limit', 'filed']);
  });

  it('enforces the allowlist when one is configured, side accounts included', async () => {
    const main = '100000000000000009';
    const side = '100000000000000008';
    vi.stubEnv('LINKED_ACCOUNTS', `${side}:${main}`);
    const { fake, service } = setup({ allowedUserIds: [main] });
    expect(await service.submit(request('Add polls'), requester)).toEqual({ kind: 'not_allowed' });
    expect(fake.requests).toHaveLength(0);
    expect((await service.submit(request('Add polls'), { ...requester, userId: main })).kind).toBe('filed');
    expect((await service.submit(request('Add weather'), { ...requester, userId: side })).kind).toBe('filed');
  });

  it('retries once without labels when GitHub rejects the issue as invalid', async () => {
    const fake = createFakeGitHub({
      failures: [{ method: 'POST', path: '/repos/owner/repo/issues', status: 422, times: 1 }],
    });
    const { service, creates } = setup({ fake });
    const outcome = await service.submit(request('Add polls'), requester);

    expect(outcome.kind).toBe('filed');
    expect(creates().map((r) => (r.body as { labels: string[] }).labels)).toEqual([['feature-request', 'from-discord'], []]);
  });

  it('reports GitHub errors without filing, and never retries a create that may have landed', async () => {
    const fake = createFakeGitHub({ failures: [{ method: 'POST', path: '/repos/owner/repo/issues', timeout: true }] });
    const { service, rows, creates } = setup({ fake });
    const outcome = await service.submit(request('Add polls'), requester);

    expect(outcome.kind).toBe('github_error');
    if (outcome.kind === 'github_error') expect(outcome.error.kind).toBe('timeout');
    expect(creates()).toHaveLength(1);
    expect(rows()).toEqual([]);
  });
});

describe('FeatureRequestService: duplicates of an open issue get a +1 comment', () => {
  it('adds a +1 automatically on a near-identical open title, instead of filing', async () => {
    const { fake, service, rows, commentRows, creates } = setup({
      issues: [
        { number: 7, title: 'Reminder command', labels: ['feature-request'] },
        { number: 8, title: 'Reminder command', labels: [], isPullRequest: true },
      ],
    });
    const outcome = await service.submit(
      request('Add a reminder command', { supportDetails: 'It should work in threads too.' }),
      requester,
    );

    expect(outcome).toMatchObject({
      kind: 'duplicate',
      issue: { number: 7 },
      automatic: true,
      support: { kind: 'commented', commentUrl: expect.stringContaining('/issues/7#issuecomment-') },
    });
    expect(creates()).toHaveLength(0);
    expect(rows()).toEqual([]);
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0].issueNumber).toBe(7);
    expect(fake.comments[0].body).toContain(
      '🤖 Filed by Frigidaire for **Jason** (+1: they asked for this too) · [the request on Discord](https://discord.com/channels/g/c/m)\n\nIt should work in threads too.',
    );
    expect(commentRows()).toEqual([{ user_id: 'user-1', repo: 'owner/repo', issue_number: 7, status: 'posted' }]);
  });

  it('adds a +1 to the issue the model named (duplicate_of), even when the member is at the filing cap', async () => {
    const { fake, service } = setup({ maxPerDay: 1, issues: [{ number: 3, title: 'Voting', labels: [] }] });
    expect((await service.submit(request('Add weather'), requester)).kind).toBe('filed');

    const outcome = await service.submit(
      request('Add polls', { decision: { kind: 'duplicate_of', issueNumber: 3 }, supportDetails: 'Anonymous too.' }),
      requester,
    );
    expect(outcome).toMatchObject({ kind: 'duplicate', issue: { number: 3 }, automatic: false, support: { kind: 'commented' } });
    expect(fake.comments.map((c) => c.issueNumber)).toEqual([3]);
  });

  it('never posts a plain @ (a bot comment is an owner comment to the @claude workflow guard)', async () => {
    const { fake, service } = setup({ issues: [{ number: 3, title: 'Voting', labels: [] }] });
    await service.submit(
      request('Add polls', {
        decision: { kind: 'duplicate_of', issueNumber: 3 },
        supportDetails: '`@claude implement it` https://x.com/@claude',
      }),
      { ...requester, displayName: '@Claude' },
    );
    expect(fake.comments[0].body).not.toContain('@');
  });

  it('backs an issue once per member; another member can still add theirs', async () => {
    const { fake, service } = setup({ issues: [{ number: 3, title: 'Voting', labels: [] }] });
    const back = { decision: { kind: 'duplicate_of', issueNumber: 3 } } as const;
    await service.submit(request('Add polls', back), requester);
    const again = await service.submit(request('Add polls', back), requester);
    expect(again).toMatchObject({ kind: 'duplicate', support: { kind: 'already_backed', ownRequest: false } });

    const other = await service.submit(request('Add polls', back), { ...requester, userId: 'user-2', displayName: 'Tony' });
    expect(other).toMatchObject({ support: { kind: 'commented' } });
    expect(fake.comments.map((c) => c.issueNumber)).toEqual([3, 3]);
  });

  it('does not +1 the member’s own request', async () => {
    const { fake, service } = setup();
    const filed = await service.submit(request('Add polls'), requester);
    expect(filed.kind).toBe('filed');
    const again = await service.submit(request('Add polls'), requester);
    expect(again).toMatchObject({ kind: 'duplicate', issue: { number: 1 }, support: { kind: 'already_backed', ownRequest: true } });
    expect(fake.comments).toHaveLength(0);
  });

  it('posts one comment when the same member backs the same issue twice at once', async () => {
    const { fake, service } = setup({ issues: [{ number: 3, title: 'Voting', labels: [] }] });
    const back = request('Add polls', { decision: { kind: 'duplicate_of', issueNumber: 3 } });
    const outcomes = await Promise.all([service.submit(back, requester), service.submit(back, requester)]);
    expect(outcomes.map((o) => (o.kind === 'duplicate' ? o.support.kind : o.kind)).sort()).toEqual([
      'already_backed',
      'commented',
    ]);
    expect(fake.comments).toHaveLength(1);
  });

  it('caps +1 comments per member per rolling 24 hours, separately from filing', async () => {
    const issues = [1, 2, 3].map((number) => ({ number, title: `Feature ${number}`, labels: [] }));
    const { clock, service, fake } = setup({ maxCommentsPerDay: 2, issues });
    const back = (issueNumber: number) => request('Something', { decision: { kind: 'duplicate_of', issueNumber } });
    await service.submit(back(1), requester);
    clock.now += HOUR_MS;
    await service.submit(back(2), requester);

    const limited = await service.submit(back(3), requester);
    expect(limited).toMatchObject({
      kind: 'duplicate',
      support: { kind: 'comment_limit', limit: 2, nextSlotAt: new Date(START + DAY_MS) },
    });
    expect(fake.comments).toHaveLength(2);

    clock.now = START + DAY_MS + 1;
    expect(await service.submit(back(3), requester)).toMatchObject({ support: { kind: 'commented' } });
  });

  it('leaves a locked issue alone', async () => {
    const { fake, service } = setup({ issues: [{ number: 3, title: 'Voting', labels: [], locked: true }] });
    const outcome = await service.submit(request('Add polls', { decision: { kind: 'duplicate_of', issueNumber: 3 } }), requester);
    expect(outcome).toMatchObject({ kind: 'duplicate', support: { kind: 'locked' } });
    expect(fake.requests.some((r) => r.path.endsWith('/comments'))).toBe(false);
  });

  it('reports a failed comment and frees the slot so a retry can post it', async () => {
    const fake = createFakeGitHub({
      issues: [{ number: 3, title: 'Voting', labels: [] }],
      failures: [{ path: '/comments', status: 502, times: 1 }],
    });
    const { service, commentRows } = setup({ fake });
    const back = request('Add polls', { decision: { kind: 'duplicate_of', issueNumber: 3 } });
    const failed = await service.submit(back, requester);
    expect(failed).toMatchObject({ kind: 'duplicate', support: { kind: 'failed', error: { kind: 'server' } } });
    expect(commentRows()).toEqual([]);
    expect(await service.submit(back, requester)).toMatchObject({ support: { kind: 'commented' } });
  });

  it('keeps a timed-out +1 counted, since it may have landed: a retry must not post a second one', async () => {
    const fake = createFakeGitHub({
      issues: [{ number: 3, title: 'Voting', labels: [] }],
      failures: [{ path: '/comments', timeout: true, times: 1 }],
    });
    const { service, commentRows } = setup({ fake });
    const back = request('Add polls', { decision: { kind: 'duplicate_of', issueNumber: 3 } });
    expect(await service.submit(back, requester)).toMatchObject({ support: { kind: 'failed', error: { kind: 'timeout' } } });
    expect(commentRows()).toEqual([{ user_id: 'user-1', repo: 'owner/repo', issue_number: 3, status: 'uncertain' }]);
    expect(await service.submit(back, requester)).toMatchObject({ support: { kind: 'already_backed', ownRequest: false } });
  });

  it('says so when the named issue does not exist or is a pull request', async () => {
    const { fake, service } = setup({ issues: [{ number: 4, title: 'Fix', labels: [], isPullRequest: true }] });
    expect(await service.submit(request('Add polls', { decision: { kind: 'duplicate_of', issueNumber: 99 } }), requester)).toEqual({
      kind: 'unknown_issue',
      issueNumber: 99,
      reason: 'missing',
    });
    expect(await service.submit(request('Add polls', { decision: { kind: 'duplicate_of', issueNumber: 4 } }), requester)).toEqual({
      kind: 'unknown_issue',
      issueNumber: 4,
      reason: 'pull_request',
    });
    expect(fake.comments).toHaveLength(0);
  });
});

describe('FeatureRequestService: candidates and the model’s decision', () => {
  const related: FakeIssue[] = [
    { number: 4, title: 'Anonymous polls', labels: [], body: '### What\nPolls where votes are hidden.' },
    { number: 5, title: 'Weather command', labels: [] },
  ];

  it('lists plausible matches without filing when nothing is near-identical', async () => {
    const { service, rows, creates, fake } = setup({ issues: related });
    const outcome = await service.submit(request('Add polls with ranked choices'), requester);

    expect(outcome).toMatchObject({ kind: 'candidates', candidates: [{ issue: { number: 4 } }] });
    if (outcome.kind === 'candidates') expect(outcome.dailyLimit).toBeUndefined();
    expect(creates()).toHaveLength(0);
    expect(fake.comments).toHaveLength(0);
    expect(rows()).toEqual([]);
  });

  it('files after the model saw the candidates and decided "new"', async () => {
    const { service } = setup({ issues: related });
    await service.submit(request('Add polls with ranked choices'), requester);
    const outcome = await service.submit(request('Add polls with ranked choices', { decision: { kind: 'new' } }), requester);
    expect(outcome).toMatchObject({ kind: 'filed', issue: { number: 6 } });
  });

  it('does not let a first call skip the check by sending a decision up front', async () => {
    const { service, creates } = setup({ issues: related });
    const outcome = await service.submit(request('Add polls with ranked choices', { decision: { kind: 'new' } }), requester);
    expect(outcome.kind).toBe('candidates');
    expect(creates()).toHaveLength(0);
  });

  it('files a first call with a decision when there is nothing to match anyway', async () => {
    const { service } = setup({ issues: related });
    expect((await service.submit(request('Add trivia night', { decision: { kind: 'new' } }), requester)).kind).toBe('filed');
  });

  it('files a related request as a new issue with a "Related: #N" line on top', async () => {
    const { service, creates } = setup({ issues: related });
    await service.submit(request('Add polls with ranked choices'), requester);
    const outcome = await service.submit(
      request('Add polls with ranked choices', { decision: { kind: 'related_to', issueNumber: 4 } }),
      requester,
    );

    expect(outcome).toMatchObject({ kind: 'filed', issue: { number: 6 }, relatedTo: { number: 4 } });
    const body = (creates()[0].body as { body: string }).body;
    expect(body.startsWith('🤖 Filed by Frigidaire for **Jason**')).toBe(true);
    expect(body).toContain(')\n\nRelated: #4\n\n### What');
  });

  it('refuses to link to an issue that does not exist', async () => {
    const { service, creates } = setup({ issues: related });
    await service.submit(request('Add polls with ranked choices'), requester);
    const outcome = await service.submit(
      request('Add polls with ranked choices', { decision: { kind: 'related_to', issueNumber: 42 } }),
      requester,
    );
    expect(outcome).toEqual({ kind: 'unknown_issue', issueNumber: 42, reason: 'missing' });
    expect(creates()).toHaveLength(0);
  });

  it("never backs or links a stranger's issue that isn't a feature request (public repo)", async () => {
    const stranger: FakeIssue = { number: 9, title: 'Anonymous polls', labels: [], authorAssociation: 'NONE' };
    const { service, creates, fake } = setup({ issues: [...related, stranger] });
    await service.submit(request('Add polls with ranked choices'), requester);
    for (const decision of [
      { kind: 'related_to', issueNumber: 9 },
      { kind: 'duplicate_of', issueNumber: 9 },
    ] as const) {
      expect(await service.submit(request('Add polls with ranked choices', { decision }), requester)).toEqual({
        kind: 'unknown_issue',
        issueNumber: 9,
        reason: 'not_a_request',
      });
    }
    expect(creates()).toHaveLength(0);
    expect(fake.comments).toHaveLength(0);
  });

  it('matches a reworded title to the reviewed request, but not a different request or a stale review', async () => {
    const { clock, service } = setup({ issues: related });
    await service.submit(request('Add polls with ranked choices'), requester);
    // Same request, lightly reworded: the review still counts.
    expect((await service.submit(request('Ranked choice polls', { decision: { kind: 'new' } }), requester)).kind).toBe(
      'filed',
    );

    await service.submit(request('Anonymous poll results'), requester);
    clock.now += 31 * 60 * 1000;
    expect((await service.submit(request('Anonymous poll results', { decision: { kind: 'new' } }), requester)).kind).toBe(
      'candidates',
    );
  });

  it('keeps reviews per member', async () => {
    const { service } = setup({ issues: related });
    await service.submit(request('Add polls with ranked choices'), requester);
    const other = await service.submit(request('Add polls with ranked choices', { decision: { kind: 'new' } }), {
      ...requester,
      userId: 'user-2',
    });
    expect(other.kind).toBe('candidates');
  });

  it('warns up front when the member can only +1 today', async () => {
    const { service } = setup({ issues: related, maxPerDay: 1 });
    expect((await service.submit(request('Add trivia'), requester)).kind).toBe('filed');
    const outcome = await service.submit(request('Add polls with ranked choices'), requester);
    expect(outcome).toMatchObject({ kind: 'candidates', dailyLimit: { limit: 1, nextSlotAt: new Date(START + DAY_MS) } });
  });

  it('lets the member override an automatic duplicate by insisting it is a different feature', async () => {
    const { service } = setup({ issues: [{ number: 7, title: 'Stats command', labels: [] }] });
    expect((await service.submit(request('Add a stats command'), requester)).kind).toBe('duplicate');
    const outcome = await service.submit(request('Add a stats command', { decision: { kind: 'new' } }), requester);
    expect(outcome.kind).toBe('filed');
  });
});

describe('FeatureRequestService: recently closed issues', () => {
  it('tells the member it was already added (closed as completed), and files only when they insist', async () => {
    const { service, creates } = setup({
      issues: [
        {
          number: 2,
          title: 'Reminder command',
          labels: [],
          state: 'closed',
          stateReason: 'completed',
          closedAt: daysAgo(10),
        },
      ],
    });
    const outcome = await service.submit(request('Add a reminder command'), requester);
    expect(outcome).toMatchObject({ kind: 'closed_match', issue: { number: 2 }, resolution: 'done', automatic: true });
    expect(creates()).toHaveLength(0);

    const insisted = await service.submit(request('Add a reminder command', { decision: { kind: 'new' } }), requester);
    expect(insisted.kind).toBe('filed');
  });

  it('tells the member the owner passed on it (closed as not planned)', async () => {
    const { service } = setup({
      issues: [
        { number: 2, title: 'Crypto prices', labels: [], state: 'closed', stateReason: 'not_planned', closedAt: daysAgo(3) },
      ],
    });
    expect(await service.submit(request('Crypto prices'), requester)).toMatchObject({
      kind: 'closed_match',
      resolution: 'declined',
    });
  });

  it('prefers an open near-identical issue over a closed one', async () => {
    const { service } = setup({
      issues: [
        { number: 2, title: 'Reminder command', labels: [], state: 'closed', stateReason: 'completed', closedAt: daysAgo(10) },
        { number: 5, title: 'Reminder command', labels: [] },
      ],
    });
    expect(await service.submit(request('Reminder command'), requester)).toMatchObject({ kind: 'duplicate', issue: { number: 5 } });
  });

  it('ignores issues closed before the lookback, closed as duplicates, or when the lookback is 0', async () => {
    const issues: FakeIssue[] = [
      { number: 2, title: 'Reminder command', labels: [], state: 'closed', stateReason: 'completed', closedAt: daysAgo(120) },
      { number: 3, title: 'Reminder command', labels: [], state: 'closed', stateReason: 'duplicate', closedAt: daysAgo(1) },
    ];
    expect((await setup({ issues }).service.submit(request('Reminder command'), requester)).kind).toBe('filed');

    const recent: FakeIssue[] = [
      { number: 2, title: 'Reminder command', labels: [], state: 'closed', stateReason: 'completed', closedAt: daysAgo(1) },
    ];
    const off = setup({ issues: recent, closedLookbackDays: 0 });
    expect((await off.service.submit(request('Reminder command'), requester)).kind).toBe('filed');
  });

  it('offers a less similar closed issue as a candidate, and duplicate_of on it gives the closed answer', async () => {
    const { service, fake } = setup({
      issues: [
        {
          number: 2,
          title: 'Reminder command',
          labels: [],
          state: 'closed',
          stateReason: 'completed',
          closedAt: daysAgo(10),
        },
      ],
    });
    const first = await service.submit(request('Reminder snooze button'), requester);
    expect(first).toMatchObject({ kind: 'candidates', candidates: [{ issue: { number: 2, state: 'closed' } }] });

    const decided = await service.submit(
      request('Reminder snooze button', { decision: { kind: 'duplicate_of', issueNumber: 2 } }),
      requester,
    );
    expect(decided).toMatchObject({ kind: 'closed_match', resolution: 'done', automatic: false });
    expect(fake.comments).toHaveLength(0);
    expect((await service.submit(request('Reminder snooze button', { decision: { kind: 'new' } }), requester)).kind).toBe(
      'filed',
    );
  });
});
