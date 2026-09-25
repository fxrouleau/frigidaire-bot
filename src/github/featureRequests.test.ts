import { describe, expect, it } from 'vitest';
import { BotDb } from '../storage/botDb';
import { type FakeGitHub, createFakeGitHub } from '../test-support/fakeGitHub';
import { GitHubClient } from './client';
import {
  FROM_DISCORD_LABEL,
  FeatureRequestService,
  type FeatureRequestServiceOptions,
  IMPLEMENT_LABEL,
  ISSUE_LABELS,
} from './featureRequests';
import type { IssueDraft } from './issueText';

const HOUR_MS = 60 * 60 * 1000;
const START = Date.parse('2026-09-25T15:00:00Z');

const requester = { userId: 'user-1', displayName: 'Jason', jumpUrl: 'https://discord.com/channels/g/c/m' };

function draft(title: string): IssueDraft {
  return { title, description: `Please build: ${title}`, acceptanceCriteria: [] };
}

function setup(opts: Partial<FeatureRequestServiceOptions> & { fake?: FakeGitHub } = {}) {
  const fake = opts.fake ?? createFakeGitHub();
  const clock = { now: START };
  const db = new BotDb(':memory:');
  const service = new FeatureRequestService({
    client: new GitHubClient({ token: 't', repo: 'owner/repo', fetch: fake.fetch }),
    maxPerDay: 3,
    allowedUserIds: [],
    db,
    now: () => clock.now,
    ensuredLabelRepos: new Set(),
    ...opts,
  });
  const rows = () => db.stmt('SELECT user_id, status, issue_number FROM feature_requests ORDER BY id').all();
  return { fake, clock, db, service, rows };
}

describe('FeatureRequestService', () => {
  it('files an issue with the fixed labels, the rendered body, and records it', async () => {
    const { fake, service, rows } = setup();
    const outcome = await service.submit(draft('Add polls'), requester);

    expect(outcome).toMatchObject({ kind: 'filed', issue: { number: 1, htmlUrl: 'https://github.com/owner/repo/issues/1' } });
    const create = fake.requests.find((r) => r.method === 'POST' && r.path.endsWith('/issues'));
    expect(create?.body).toMatchObject({ title: 'Add polls', labels: ['feature-request', 'from-discord'] });
    expect((create?.body as { body: string }).body).toContain('Requested by **Jason**');
    expect(rows()).toEqual([{ user_id: 'user-1', status: 'filed', issue_number: 1 }]);
  });

  it('never applies the owner-approval label (the bot token IS the owner, so it would count as approval)', async () => {
    const { fake, service } = setup();
    await service.submit(draft('Add polls'), requester);
    expect(ISSUE_LABELS).not.toContain(IMPLEMENT_LABEL);
    for (const request of fake.requests.filter((r) => r.path.endsWith('/issues') && r.method === 'POST')) {
      expect((request.body as { labels: string[] }).labels).not.toContain(IMPLEMENT_LABEL);
    }
  });

  it('ensures the labels once per repo, best-effort', async () => {
    const fake = createFakeGitHub({ labels: [FROM_DISCORD_LABEL] });
    const ensured = new Set<string>();
    const { service } = setup({ fake, ensuredLabelRepos: ensured });
    await service.submit(draft('Add polls'), requester);
    await service.submit(draft('Add weather'), requester);

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

    expect((await service.submit(draft('Add polls'), requester)).kind).toBe('filed');
    expect(ensured.size).toBe(0);
    await service.submit(draft('Add weather'), requester);
    expect(ensured.has('owner/repo')).toBe(true);
  });

  it('returns a clearly matching open issue instead of filing a duplicate, and frees the slot', async () => {
    const fake = createFakeGitHub({
      issues: [
        { number: 7, title: 'Reminder command', labels: ['feature-request'] },
        { number: 8, title: 'Reminder command', labels: [], isPullRequest: true },
      ],
    });
    const { service, rows } = setup({ fake });
    const outcome = await service.submit(draft('Add a reminder command'), requester);

    expect(outcome).toMatchObject({ kind: 'duplicate', issue: { number: 7 } });
    expect(fake.requests.some((r) => r.method === 'POST' && r.path.endsWith('/issues'))).toBe(false);
    expect(rows()).toEqual([]);
  });

  it('stops at the first fatal error (bad token, rate limit) instead of repeating it on every call', async () => {
    const fake = createFakeGitHub({ failures: [{ status: 401, body: { message: 'Bad credentials' } }] });
    const { service, rows } = setup({ fake });
    const outcome = await service.submit(draft('Add polls'), requester);

    expect(outcome.kind).toBe('github_error');
    if (outcome.kind === 'github_error') expect(outcome.error.kind).toBe('auth');
    expect(fake.requests.every((r) => r.path.endsWith('/labels'))).toBe(true);
    expect(rows()).toEqual([]);

    const limited = createFakeGitHub({ failures: [{ method: 'GET', status: 429 }] });
    const second = setup({ fake: limited });
    expect((await second.service.submit(draft('Add polls'), requester)).kind).toBe('github_error');
    expect(limited.requests.some((r) => r.method === 'POST' && r.path.endsWith('/issues'))).toBe(false);
  });

  it('files anyway when the duplicate check itself fails', async () => {
    const fake = createFakeGitHub({ failures: [{ method: 'GET', path: '/issues', status: 502 }] });
    const { service } = setup({ fake });
    expect((await service.submit(draft('Add polls'), requester)).kind).toBe('filed');
  });

  it('caps each member at maxPerDay in a rolling 24 hours; others are unaffected', async () => {
    const { clock, service } = setup({ maxPerDay: 2 });
    expect((await service.submit(draft('Add polls'), requester)).kind).toBe('filed');
    clock.now += HOUR_MS;
    expect((await service.submit(draft('Add weather'), requester)).kind).toBe('filed');
    clock.now += HOUR_MS;

    const limited = await service.submit(draft('Add trivia'), requester);
    expect(limited).toEqual({ kind: 'daily_limit', limit: 2, nextSlotAt: new Date(START + 24 * HOUR_MS) });

    const other = await service.submit(draft('Add trivia'), { ...requester, userId: 'user-2' });
    expect(other.kind).toBe('filed');

    // The first request ages out of the window exactly 24 hours after it was filed.
    clock.now = START + 24 * HOUR_MS + 1;
    expect((await service.submit(draft('Add chess'), requester)).kind).toBe('filed');
  });

  it('does not count failed or duplicate attempts against the cap', async () => {
    const fake = createFakeGitHub({
      issues: [{ number: 1, title: 'Polls', labels: [] }],
      failures: [{ method: 'POST', path: '/issues', status: 500, times: 2 }],
    });
    const { service, rows } = setup({ fake, maxPerDay: 1 });
    expect((await service.submit(draft('Add weather'), requester)).kind).toBe('github_error');
    expect((await service.submit(draft('Add weather'), requester)).kind).toBe('github_error');
    expect((await service.submit(draft('Add polls'), requester)).kind).toBe('duplicate');
    expect(rows()).toEqual([]);
    expect((await service.submit(draft('Add weather'), requester)).kind).toBe('filed');
  });

  it('reserves the slot before the first await, so parallel requests cannot exceed the cap', async () => {
    const { service } = setup({ maxPerDay: 1 });
    const outcomes = await Promise.all([
      service.submit(draft('Add polls'), requester),
      service.submit(draft('Add weather'), requester),
    ]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(['daily_limit', 'filed']);
  });

  it('enforces the allowlist when one is configured', async () => {
    const { fake, service } = setup({ allowedUserIds: ['user-9'] });
    expect(await service.submit(draft('Add polls'), requester)).toEqual({ kind: 'not_allowed' });
    expect(fake.requests).toHaveLength(0);
    expect((await service.submit(draft('Add polls'), { ...requester, userId: 'user-9' })).kind).toBe('filed');
  });

  it('retries once without labels when GitHub rejects the issue as invalid', async () => {
    const fake = createFakeGitHub({ failures: [{ method: 'POST', path: '/issues', status: 422, times: 1 }] });
    const { service } = setup({ fake });
    const outcome = await service.submit(draft('Add polls'), requester);

    expect(outcome.kind).toBe('filed');
    const creates = fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/issues'));
    expect(creates.map((r) => (r.body as { labels: string[] }).labels)).toEqual([['feature-request', 'from-discord'], []]);
  });

  it('reports GitHub errors without filing, and never retries a create that may have landed', async () => {
    const fake = createFakeGitHub({ failures: [{ method: 'POST', path: '/issues', timeout: true }] });
    const { service, rows } = setup({ fake });
    const outcome = await service.submit(draft('Add polls'), requester);

    expect(outcome.kind).toBe('github_error');
    if (outcome.kind === 'github_error') expect(outcome.error.kind).toBe('timeout');
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/issues'))).toHaveLength(1);
    expect(rows()).toEqual([]);
  });
});
