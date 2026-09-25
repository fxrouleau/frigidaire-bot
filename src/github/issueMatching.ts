// Finding the existing issues a new feature request might duplicate or relate to.
//
// Two sources are merged: GitHub's issue search (hybrid semantic + keyword, over this repo's open AND
// closed issues, in GitHub's relevance order) and the full list of open issues (the search index lags a
// little behind a just-filed issue, and the listing still works when search is rate-limited). Then:
//   - a near-identical title (the same scorer and threshold as before) is handled without asking the
//     model: an open one gets the member's +1, a recently closed one is what they are told about
//   - otherwise up to three plausible matches go back to the chat model, which decides semantically
//     whether the request is a duplicate, related, or new (the second request_feature call)
// "Plausible" is deliberately loose (a missed duplicate is worse than one extra tool round, and the model
// makes the call), but semantic search always returns SOMETHING, so a search hit must share at least one
// content word with the request's title to count; everything else needs some title overlap.
//
// Only feature requests are ever candidates: issues labelled `feature-request` (every issue the bot files
// is) or opened by the owner or a collaborator. The repo is public, so any other issue is text from a
// stranger, and candidates are shown to the chat model: an injection surface, and never a request a
// member could be +1-ing anyway.
import type { GitHubIssue } from './client';
import { DUPLICATE_THRESHOLD, contentWords, issueSummary, titleSimilarity, titleTokens } from './issueText';

export const FEATURE_REQUEST_LABEL = 'feature-request';
/** `author_association` values of people with a say in the repo: the owner, org members, collaborators. */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** A feature request the bot may match against: labelled as one, or opened by the owner/a collaborator. */
export function isFeatureRequestIssue(issue: GitHubIssue): boolean {
  if (issue.labels.includes(FEATURE_REQUEST_LABEL)) return true;
  return issue.authorAssociation !== undefined && TRUSTED_ASSOCIATIONS.has(issue.authorAssociation);
}

/** Title overlap that makes an issue worth showing even without a search hit (e.g. 1 of 4 words). */
export const RELATED_TITLE_THRESHOLD = 0.25;
export const MAX_CANDIDATES = 3;
/** Keywords sent to the search: GitHub caps free text at 256 characters, and a title never needs more. */
const MAX_SEARCH_TERMS = 8;
/** How much of a body is read for word overlap (the "What" section of an issue the bot filed). */
const SUMMARY_SCAN_CHARS = 2000;
// Reciprocal-rank fusion constant. Small because both lists are short (≤ 10 hits, a few dozen issues):
// agreement between the two rankings should outweigh a single first place.
const RRF_K = 10;

/**
 * How a closed issue ended, in the words the member hears:
 * - done: closed as completed, which is also what merging a PR that says "Closes #N" does
 * - declined: closed as not planned, i.e. the owner passed on it
 * - duplicate: closed as a duplicate of another issue (the original is the real match)
 * - closed: closed without a reason GitHub reports
 */
export type ClosedResolution = 'done' | 'declined' | 'duplicate' | 'closed';

export function closedResolution(issue: GitHubIssue): ClosedResolution {
  switch (issue.stateReason) {
    case 'completed':
      return 'done';
    case 'not_planned':
      return 'declined';
    case 'duplicate':
      return 'duplicate';
    default:
      return 'closed';
  }
}

export type IssueCandidate = {
  issue: GitHubIssue;
  /** Title similarity to the request (0..1). */
  titleScore: number;
  /** 0-based position in GitHub's search ranking, when the search returned it. */
  searchRank?: number;
};

export type IssueMatches = {
  /** Near-identical title: an open issue when there is one, else a recently closed one. */
  automatic?: GitHubIssue;
  /** Plausible matches for the model to judge, best first; never includes `automatic`. */
  candidates: IssueCandidate[];
};

/**
 * The request title's content words, as search keywords ('' when it has none). Unstemmed: the search
 * does its own matching, and a crude stem ("anonymou") would match nothing.
 */
export function searchTerms(title: string): string {
  return contentWords(title).slice(0, MAX_SEARCH_TERMS).join(' ');
}

/**
 * Feature requests only (see isFeatureRequestIssue). Open ones always qualify; closed ones only within
 * the lookback window (an old decision is not worth re-litigating, and the feature may have changed
 * since), and never those closed as duplicates: the issue they duplicate is the one to talk about, and
 * it is found on its own.
 */
export function isEligible(issue: GitHubIssue, now: number, closedLookbackMs: number): boolean {
  if (issue.isPullRequest || !isFeatureRequestIssue(issue)) return false;
  if (issue.state === 'open') return true;
  if (issue.stateReason === 'duplicate' || closedLookbackMs <= 0) return false;
  return issue.closedAt !== undefined && issue.closedAt >= now - closedLookbackMs;
}

function sharesTitleWord(requestTokens: Set<string>, issue: GitHubIssue): boolean {
  const issueTokens = titleTokens(`${issue.title} ${issueSummary(issue.body, SUMMARY_SCAN_CHARS)}`);
  for (const token of requestTokens) if (issueTokens.has(token)) return true;
  return false;
}

export function matchIssues(
  title: string,
  sources: { open: GitHubIssue[]; searchHits: GitHubIssue[] },
  opts: { now: number; closedLookbackMs: number },
): IssueMatches {
  const pool = new Map<number, IssueCandidate>();
  sources.searchHits.forEach((issue, rank) => {
    if (!pool.has(issue.number) && isEligible(issue, opts.now, opts.closedLookbackMs)) {
      pool.set(issue.number, { issue, titleScore: titleSimilarity(title, issue.title), searchRank: rank });
    }
  });
  for (const issue of sources.open) {
    if (pool.has(issue.number) || !isEligible(issue, opts.now, opts.closedLookbackMs)) continue;
    pool.set(issue.number, { issue, titleScore: titleSimilarity(title, issue.title) });
  }
  const entries = [...pool.values()];

  // The near-identical shortcut: an open request wins over a closed one (it is the live one).
  const nearIdentical = entries
    .filter((entry) => entry.titleScore >= DUPLICATE_THRESHOLD)
    .sort((a, b) => Number(b.issue.state === 'open') - Number(a.issue.state === 'open') || b.titleScore - a.titleScore);
  const automatic = nearIdentical[0]?.issue;

  const requestTokens = titleTokens(title);
  const plausible = entries.filter(
    (entry) =>
      entry.issue !== automatic &&
      (entry.titleScore >= RELATED_TITLE_THRESHOLD ||
        (entry.searchRank !== undefined && sharesTitleWord(requestTokens, entry.issue))),
  );

  const titleRank = new Map(
    [...entries]
      .filter((entry) => entry.titleScore > 0)
      .sort((a, b) => b.titleScore - a.titleScore)
      .map((entry, rank) => [entry.issue.number, rank]),
  );
  const fused = (entry: IssueCandidate): number => {
    const byTitle = titleRank.get(entry.issue.number);
    return (
      (entry.searchRank !== undefined ? 1 / (RRF_K + entry.searchRank + 1) : 0) +
      (byTitle !== undefined ? 1 / (RRF_K + byTitle + 1) : 0)
    );
  };
  const candidates = plausible
    .sort((a, b) => fused(b) - fused(a) || b.issue.number - a.issue.number)
    .slice(0, MAX_CANDIDATES);

  return { automatic, candidates };
}
