// Live checks of the GitHub endpoints the feature-request flow READS, against the real repo. They are
// skipped unless RUN_LIVE=1, GITHUB_TOKEN and GITHUB_REPO are set, so they never run in CI:
//   docker compose run --rm -e RUN_LIVE=1 -e GITHUB_TOKEN=github_pat_... -e GITHUB_REPO=owner/name test yarn test:live
// Read-only on purpose: nothing here creates an issue, a label or a comment. What they confirm:
//   - the fine-grained PAT can list, search and read issues on the repo
//   - hybrid (semantic + keyword) issue search runs for this repo, or which fallback GitHub reports
//     (grep the output for GITHUB_SEARCH)
//   - response shapes still parse (state, state_reason, closed_at) under the pinned API version
import { describe, expect, it } from 'vitest';
import { GitHubClient } from './client';

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPO;
const RUN_LIVE = process.env.RUN_LIVE === '1' && !!token && !!repo;

describe.skipIf(!RUN_LIVE)('GitHub issue endpoints (live, read-only)', () => {
  const client = new GitHubClient({ token: token ?? '', repo: repo ?? '' });

  it('lists open issues (no pull requests)', async () => {
    const issues = await client.listOpenIssues();
    for (const issue of issues) {
      expect(issue.isPullRequest).toBe(false);
      expect(issue.state).toBe('open');
    }
    console.log(`GITHUB_LIST open=${issues.length}`);
  }, 30_000);

  it('runs a hybrid issue search scoped to the repo', async () => {
    const result = await client.searchIssues('feature request command', { searchType: 'hybrid', perPage: 5 });
    console.log(
      `GITHUB_SEARCH type=${result.searchType ?? '(none)'} fallback=${result.fallbackReasons.join(',') || '-'} hits=${result.issues
        .map((issue) => `#${issue.number}:${issue.state}${issue.stateReason ? `/${issue.stateReason}` : ''}`)
        .join(',')}`,
    );
    expect(['hybrid', 'lexical', undefined]).toContain(result.searchType);
    for (const issue of result.issues) {
      expect(issue.htmlUrl.toLowerCase()).toContain(`github.com/${repo?.toLowerCase()}/issues/`);
      if (issue.state === 'closed') expect(issue.closedAt).toBeTypeOf('number');
    }
  }, 30_000);

  it('reads one issue by number, and answers undefined for one that does not exist', async () => {
    const [first] = (await client.searchIssues('is:closed', { perPage: 1 })).issues;
    if (first) expect((await client.getIssue(first.number))?.number).toBe(first.number);
    expect(await client.getIssue(999_999_999)).toBeUndefined();
  }, 30_000);
});
