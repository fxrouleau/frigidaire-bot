// Members ask the bot for a feature → it files a GitHub issue → the owner approves it by adding the
// `claude-implement` label → a GitHub Actions workflow has Claude implement it in a PR
// (.github/workflows/claude-feature-request.yml).
//
// This module is the filing half: allowlist, per-member daily caps (bot.db), matching against existing
// feature requests (labelled `feature-request`, or opened by the owner or a collaborator: on a public
// repo any other issue is a stranger's text, see issueMatching.ts), and what happens on a match:
//   - the same as an OPEN request      → the member's +1 is added to it as a comment (own daily cap)
//   - the same as a recently CLOSED one → nothing is filed; the member hears it was done (closed as
//     completed, which merging a "Closes #N" PR does) or that the owner passed on it (not planned)
//   - related to one                   → a new issue that starts with "Related: #N"
//   - new                              → a new issue
// A near-identical title is decided here without asking. Anything less clear goes back to the chat model
// as up to three candidates, and the model calls again with an explicit decision: it judges meaning,
// which a title scorer cannot. A decision is only trusted after the model has seen the candidates (or the
// closed match) for this member and request, so `decision: 'new'` on a first call cannot skip the check.
//
// The bot never edits issues and never applies `claude-implement`: its token belongs to the repo owner,
// so a label it applied would look exactly like the owner's approval to the workflow, and its comments
// are owner comments too (see renderSupportComment for what that means for their text). That is also
// why every issue and comment it posts opens with "🤖 Filed by Frigidaire for <member>". The label set
// below is fixed in code for that reason; nothing the model writes can extend it.
import { isSamePerson } from '../linkedAccounts';
import { logger } from '../logger';
import { type BotDb, getBotDb } from '../storage/botDb';
import { GitHubApiError, type GitHubErrorKind, type GitHubIssue, type GitHubIssuesApi, type LabelSpec } from './client';
import {
  type ClosedResolution,
  closedResolution,
  FEATURE_REQUEST_LABEL,
  type IssueCandidate,
  isFeatureRequestIssue,
  matchIssues,
  searchTerms,
} from './issueMatching';
import {
  type IssueDraft,
  type IssueRequester,
  renderIssueBody,
  renderSupportComment,
  titleSimilarity,
} from './issueText';

export { FEATURE_REQUEST_LABEL };
export const FROM_DISCORD_LABEL = 'from-discord';
/** The owner's approval label; the workflow only acts on it when the repo owner applied it. */
export const IMPLEMENT_LABEL = 'claude-implement';

/** Labels every filed issue carries. Deliberately does NOT include IMPLEMENT_LABEL (see top of file). */
export const ISSUE_LABELS: readonly string[] = [FEATURE_REQUEST_LABEL, FROM_DISCORD_LABEL];

// Created best-effort so they exist with a description and color; IMPLEMENT_LABEL is created too (a
// label's existence triggers nothing) so the owner finds it in the label picker.
const LABEL_SPECS: readonly LabelSpec[] = [
  { name: FEATURE_REQUEST_LABEL, color: 'a2eeef', description: 'A feature a server member asked for' },
  { name: FROM_DISCORD_LABEL, color: '5865f2', description: 'Filed by Frigidaire from a Discord conversation' },
  { name: IMPLEMENT_LABEL, color: 'd97757', description: 'Owner approval: Claude implements this issue in a PR' },
];

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long candidates shown to a member keep their decision valid (one conversation, give or take). */
const REVIEW_TTL_MS = 30 * 60 * 1000;
/** A second call counts as the same request when its title is this close to the reviewed one. */
const REVIEW_TITLE_MATCH = 0.5;
/** Search hits read per request: plenty for the top three once closed/duplicate/unrelated ones drop out. */
const SEARCH_PAGE_SIZE = 10;

// Failures that doom the whole request wherever they happen: the best-effort steps (labels, matching)
// stop on them instead of carrying on into a create that would fail the same way.
const FATAL_KINDS: ReadonlySet<GitHubErrorKind> = new Set(['auth', 'not_found', 'disabled', 'rate_limited']);

function isFatal(error: unknown): error is GitHubApiError {
  return error instanceof GitHubApiError && FATAL_KINDS.has(error.kind);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS feature_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    status       TEXT    NOT NULL,
    issue_number INTEGER,
    issue_url    TEXT,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_feature_requests_user_time ON feature_requests(user_id, created_at);
`;

// One row per +1 comment: 'pending' while it is being posted, 'posted' after, 'uncertain' when the post
// timed out (it may have landed). Also answers "did this member already back that issue?", so a member
// cannot +1 the same request twice.
const COMMENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS feature_request_comments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT    NOT NULL,
    repo         TEXT    NOT NULL,
    issue_number INTEGER NOT NULL,
    status       TEXT    NOT NULL,
    comment_url  TEXT,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_feature_request_comments_user_time ON feature_request_comments(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_feature_request_comments_issue ON feature_request_comments(repo, issue_number, user_id);
`;

export type UnknownIssueReason = 'missing' | 'pull_request' | 'not_a_request';

/** Why an issue the model named can't be +1'd or related to (undefined: it can). */
function unusableIssue(issue: GitHubIssue | undefined): UnknownIssueReason | undefined {
  if (!issue) return 'missing';
  if (issue.isPullRequest) return 'pull_request';
  // A stranger's issue on the public repo: never +1'd with the owner's token, nor linked from a new one.
  if (!isFeatureRequestIssue(issue)) return 'not_a_request';
  return undefined;
}

/** What the model decided after seeing the candidates. */
export type FeatureRequestDecision =
  | { kind: 'duplicate_of'; issueNumber: number }
  | { kind: 'related_to'; issueNumber: number }
  | { kind: 'new' };

export type FeatureRequestInput = {
  /** Must already be sanitized (see issueText.ts). */
  draft: IssueDraft;
  decision?: FeatureRequestDecision;
  /** Sanitized details for a +1 comment; none ⇒ a bare +1. */
  supportDetails?: string;
};

/** What happened to the member's +1 on a matching open issue. */
export type SupportResult =
  | { kind: 'commented'; commentUrl: string }
  | { kind: 'already_backed'; ownRequest: boolean }
  | { kind: 'locked' }
  | { kind: 'comment_limit'; limit: number; nextSlotAt: Date }
  | { kind: 'failed'; error: GitHubApiError };

export type DailyLimit = { limit: number; nextSlotAt: Date };

export type FeatureRequestOutcome =
  | { kind: 'filed'; issue: GitHubIssue; relatedTo?: GitHubIssue }
  | { kind: 'duplicate'; issue: GitHubIssue; automatic: boolean; support: SupportResult }
  | { kind: 'closed_match'; issue: GitHubIssue; resolution: ClosedResolution; automatic: boolean }
  | { kind: 'candidates'; candidates: IssueCandidate[]; dailyLimit?: DailyLimit }
  /** 'not_a_request': an issue that is neither labelled feature-request nor opened by the owner/a collaborator. */
  | { kind: 'unknown_issue'; issueNumber: number; reason: UnknownIssueReason }
  | { kind: 'not_allowed' }
  | ({ kind: 'daily_limit' } & DailyLimit)
  | { kind: 'github_error'; error: GitHubApiError };

export type FeatureRequestServiceOptions = {
  client: GitHubIssuesApi;
  maxPerDay: number;
  maxCommentsPerDay: number;
  /** Closed issues older than this are not matched; 0 ⇒ closed issues are never matched. */
  closedLookbackDays: number;
  /** Discord user ids allowed to file; empty ⇒ everyone. */
  allowedUserIds: readonly string[];
  db?: BotDb;
  now?: () => number;
  /** Repos whose labels were already ensured in this process (shared across service instances). */
  ensuredLabelRepos?: Set<string>;
  /** Who was shown candidates for what (shared across service instances; the tool builds one per call). */
  reviews?: CandidateReviews;
};

/** `userId` should be the member's canonical (main-account) id: caps and +1s are per person. */
export type FeatureRequester = IssueRequester & { userId: string };

/**
 * Which member was recently shown candidates (or told about a closed match) for which request. In
 * memory on purpose: it only has to outlive one conversation turn or two, and after a restart the worst
 * case is that the candidates are shown once more.
 */
export class CandidateReviews {
  private readonly entries = new Map<string, Array<{ repo: string; title: string; at: number }>>();

  constructor(private readonly ttlMs = REVIEW_TTL_MS) {}

  record(userId: string, repo: string, title: string, now: number): void {
    const kept = this.live(userId, now).filter((entry) => entry.repo !== repo || entry.title !== title);
    // A handful per member is plenty; the cap keeps a chatty member from growing the map.
    this.entries.set(userId, [...kept, { repo, title, at: now }].slice(-5));
  }

  wasReviewed(userId: string, repo: string, title: string, now: number): boolean {
    return this.live(userId, now).some(
      (entry) => entry.repo === repo && titleSimilarity(entry.title, title) >= REVIEW_TITLE_MATCH,
    );
  }

  private live(userId: string, now: number) {
    const live = (this.entries.get(userId) ?? []).filter((entry) => now - entry.at < this.ttlMs);
    if (live.length === 0) this.entries.delete(userId);
    return live;
  }
}

const defaultEnsuredLabelRepos = new Set<string>();
const defaultReviews = new CandidateReviews();

export class FeatureRequestService {
  private readonly client: GitHubIssuesApi;
  private readonly maxPerDay: number;
  private readonly maxCommentsPerDay: number;
  private readonly closedLookbackMs: number;
  private readonly allowedUserIds: readonly string[];
  private readonly botDb: BotDb;
  private readonly now: () => number;
  private readonly ensuredLabelRepos: Set<string>;
  private readonly reviews: CandidateReviews;

  constructor(opts: FeatureRequestServiceOptions) {
    this.client = opts.client;
    this.maxPerDay = opts.maxPerDay;
    this.maxCommentsPerDay = opts.maxCommentsPerDay;
    this.closedLookbackMs = opts.closedLookbackDays * DAY_MS;
    this.allowedUserIds = opts.allowedUserIds;
    this.botDb = opts.db ?? getBotDb();
    this.now = opts.now ?? Date.now;
    this.ensuredLabelRepos = opts.ensuredLabelRepos ?? defaultEnsuredLabelRepos;
    this.reviews = opts.reviews ?? defaultReviews;
    this.botDb.ensureSchema('feature_requests', SCHEMA);
    this.botDb.ensureSchema('feature_request_comments', COMMENTS_SCHEMA);
  }

  async submit(input: FeatureRequestInput, requester: FeatureRequester): Promise<FeatureRequestOutcome> {
    if (!this.isAllowed(requester.userId)) return { kind: 'not_allowed' };
    try {
      return await this.decide(input, requester);
    } catch (error) {
      if (error instanceof GitHubApiError) return { kind: 'github_error', error };
      throw error;
    }
  }

  private isAllowed(userId: string): boolean {
    return this.allowedUserIds.length === 0 || this.allowedUserIds.some((id) => isSamePerson(id, userId));
  }

  private async decide(input: FeatureRequestInput, requester: FeatureRequester): Promise<FeatureRequestOutcome> {
    const { draft, decision } = input;
    // A +1 never files anything, so it needs no review first: the model named the issue.
    if (decision?.kind === 'duplicate_of') return this.backNamedIssue(decision.issueNumber, input, requester);

    const reviewed =
      decision !== undefined && this.reviews.wasReviewed(requester.userId, this.client.repo, draft.title, this.now());
    if (!reviewed) {
      const { automatic, candidates } = await this.findMatches(draft.title);
      // Every answer below is remembered as reviewed: if the member says it's a different feature after
      // hearing about the match, `decision: 'new'` goes through on the next call.
      if (automatic || candidates.length > 0) {
        this.reviews.record(requester.userId, this.client.repo, draft.title, this.now());
      }
      if (automatic?.state === 'open') return this.duplicate(automatic, true, input, requester);
      if (automatic) return this.closedMatch(automatic, true, draft.title, requester);
      if (candidates.length > 0) {
        logger.info(
          `feature_request candidates user=${requester.userId} issues=${candidates.map((c) => `#${c.issue.number}`).join(',')}`,
        );
        return { kind: 'candidates', candidates, dailyLimit: this.peekDailyLimit(requester.userId) };
      }
      // Nothing plausible: whatever the model decided (or not), filing is right.
    }

    let relatedTo: GitHubIssue | undefined;
    if (decision?.kind === 'related_to') {
      relatedTo = await this.client.getIssue(decision.issueNumber);
      const unusable = unusableIssue(relatedTo);
      if (unusable) return { kind: 'unknown_issue', issueNumber: decision.issueNumber, reason: unusable };
    }
    return this.file(draft, requester, relatedTo);
  }

  private async backNamedIssue(
    issueNumber: number,
    input: FeatureRequestInput,
    requester: FeatureRequester,
  ): Promise<FeatureRequestOutcome> {
    const issue = await this.client.getIssue(issueNumber);
    const unusable = unusableIssue(issue);
    if (!issue || unusable) return { kind: 'unknown_issue', issueNumber, reason: unusable ?? 'missing' };
    if (issue.state === 'closed') return this.closedMatch(issue, false, input.draft.title, requester);
    return this.duplicate(issue, false, input, requester);
  }

  private async duplicate(
    issue: GitHubIssue,
    automatic: boolean,
    input: FeatureRequestInput,
    requester: FeatureRequester,
  ): Promise<FeatureRequestOutcome> {
    const support = await this.addSupport(issue, input.supportDetails, requester);
    logger.info(
      `feature_request duplicate user=${requester.userId} issue=#${issue.number} automatic=${automatic} support=${support.kind}`,
    );
    return { kind: 'duplicate', issue, automatic, support };
  }

  /** Remembered as reviewed: if the member insists after hearing about it, `decision: 'new'` files. */
  private closedMatch(
    issue: GitHubIssue,
    automatic: boolean,
    title: string,
    requester: FeatureRequester,
  ): FeatureRequestOutcome {
    this.reviews.record(requester.userId, this.client.repo, title, this.now());
    const resolution = closedResolution(issue);
    logger.info(
      `feature_request closed_match user=${requester.userId} issue=#${issue.number} resolution=${resolution} automatic=${automatic}`,
    );
    return { kind: 'closed_match', issue, resolution, automatic };
  }

  /**
   * Open issues (listing) and search hits, fetched in parallel. Both are best-effort: when one fails
   * transiently the other still gives the near-identical shortcut its chance, and when both fail,
   * filing a possible duplicate beats not filing. Fatal errors (bad token, repo gone, rate limit on the
   * core API) still stop the request.
   */
  private async findMatches(title: string) {
    const terms = searchTerms(title);
    const [open, searchHits] = await Promise.all([
      this.client.listOpenIssues().catch((error: unknown) => {
        if (isFatal(error)) throw error;
        logger.warn('feature_request: listing open issues failed, matching on search hits only:', describeError(error));
        return [];
      }),
      terms ? this.search(terms) : Promise.resolve([]),
    ]);
    return matchIssues(title, { open, searchHits }, { now: this.now(), closedLookbackMs: this.closedLookbackMs });
  }

  /** Never throws: search has its own (smaller) rate limit, and a failed search only loses candidates. */
  private async search(terms: string): Promise<GitHubIssue[]> {
    try {
      const result = await this.client.searchIssues(terms, { searchType: 'hybrid', perPage: SEARCH_PAGE_SIZE });
      if (result.searchType && result.searchType !== 'hybrid') {
        logger.info(
          `feature_request: issue search ran as ${result.searchType} (${result.fallbackReasons.join(',') || 'no reason given'})`,
        );
      }
      return result.issues;
    } catch (error) {
      logger.warn('feature_request: issue search failed, matching on open issues only:', describeError(error));
      return [];
    }
  }

  /** The member's +1 on an open issue: one per member per issue, capped per day, never on a locked issue. */
  private async addSupport(
    issue: GitHubIssue,
    details: string | undefined,
    requester: FeatureRequester,
  ): Promise<SupportResult> {
    // A locked issue is one the owner closed to discussion; a +1 there would only be posted because the
    // token is the owner's, which is exactly the wrong reason.
    if (issue.locked) return { kind: 'locked' };
    const reservation = this.reserveComment(requester.userId, issue.number);
    if (reservation.kind !== 'reserved') return reservation;

    // Kept unless GitHub certainly rejected the comment. A timeout keeps it too: the comment may have
    // landed, and a retry then answers "already backed" instead of posting a second +1 as the owner.
    let keepRow = false;
    try {
      const comment = await this.client.createComment(issue.number, renderSupportComment(requester, details));
      keepRow = true;
      try {
        this.botDb
          .stmt("UPDATE feature_request_comments SET status = 'posted', comment_url = ? WHERE id = ?")
          .run(comment.htmlUrl, reservation.id);
      } catch (error) {
        logger.warn(`feature_request: +1 on #${issue.number} posted but not recorded:`, describeError(error));
      }
      return { kind: 'commented', commentUrl: comment.htmlUrl };
    } catch (error) {
      if (!(error instanceof GitHubApiError)) throw error;
      if (error.kind === 'timeout') {
        keepRow = true;
        this.botDb.stmt("UPDATE feature_request_comments SET status = 'uncertain' WHERE id = ?").run(reservation.id);
      }
      return { kind: 'failed', error };
    } finally {
      if (!keepRow) this.botDb.stmt('DELETE FROM feature_request_comments WHERE id = ?').run(reservation.id);
    }
  }

  /**
   * Like reserveSlot: check and insert in one synchronous transaction before the first await, so the
   * same member backing the same issue from two channels at once posts one comment, not two.
   */
  private reserveComment(
    userId: string,
    issueNumber: number,
  ): { kind: 'reserved'; id: number } | Extract<SupportResult, { kind: 'already_backed' | 'comment_limit' }> {
    const now = this.now();
    const repo = this.client.repo;
    return this.botDb.transaction(() => {
      const ownRequest = this.botDb
        .stmt("SELECT 1 FROM feature_requests WHERE user_id = ? AND issue_number = ? AND status = 'filed' LIMIT 1")
        .get(userId, issueNumber);
      if (ownRequest) return { kind: 'already_backed', ownRequest: true };
      const backed = this.botDb
        .stmt('SELECT 1 FROM feature_request_comments WHERE repo = ? AND issue_number = ? AND user_id = ? LIMIT 1')
        .get(repo, issueNumber, userId);
      if (backed) return { kind: 'already_backed', ownRequest: false };

      const recent = this.botDb
        .stmt(
          'SELECT created_at FROM feature_request_comments WHERE user_id = ? AND created_at > ? ORDER BY created_at ASC',
        )
        .all(userId, now - DAY_MS) as Array<{ created_at: number }>;
      if (recent.length >= this.maxCommentsPerDay) {
        return {
          kind: 'comment_limit',
          limit: this.maxCommentsPerDay,
          nextSlotAt: new Date(recent[0].created_at + DAY_MS),
        };
      }
      const result = this.botDb
        .stmt(
          "INSERT INTO feature_request_comments (user_id, repo, issue_number, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
        )
        .run(userId, repo, issueNumber, now);
      return { kind: 'reserved', id: Number(result.lastInsertRowid) };
    });
  }

  private async file(
    draft: IssueDraft,
    requester: FeatureRequester,
    relatedTo?: GitHubIssue,
  ): Promise<FeatureRequestOutcome> {
    // The slot is reserved synchronously (check + insert in one transaction) before the create, so two
    // requests racing in different channels cannot both squeeze under the cap. It is released again when
    // nothing gets filed; a crash mid-request leaves it counted, which errs on the safe side.
    const reservation = this.reserveSlot(requester.userId, draft.title);
    if (reservation.kind === 'daily_limit') return reservation;

    let filed = false;
    try {
      await this.ensureLabels();
      const issue = await this.createIssue(draft, requester, relatedTo?.number);
      // The issue exists from here on, whatever happens to the bookkeeping: the slot stays taken.
      filed = true;
      logger.info(
        `feature_request filed user=${requester.userId} issue=#${issue.number}${relatedTo ? ` related=#${relatedTo.number}` : ''}`,
      );
      try {
        this.botDb
          .stmt("UPDATE feature_requests SET status = 'filed', issue_number = ?, issue_url = ? WHERE id = ?")
          .run(issue.number, issue.htmlUrl, reservation.id);
      } catch (error) {
        logger.warn(`feature_request: issue #${issue.number} filed but not recorded:`, describeError(error));
      }
      return { kind: 'filed', issue, relatedTo };
    } finally {
      if (!filed) this.botDb.stmt('DELETE FROM feature_requests WHERE id = ?').run(reservation.id);
    }
  }

  private dailyLimitAt(userId: string, now: number): DailyLimit | undefined {
    const recent = this.botDb
      .stmt('SELECT created_at FROM feature_requests WHERE user_id = ? AND created_at > ? ORDER BY created_at ASC')
      .all(userId, now - DAY_MS) as Array<{ created_at: number }>;
    // The oldest request in the window is the first to age out of it.
    return recent.length >= this.maxPerDay
      ? { limit: this.maxPerDay, nextSlotAt: new Date(recent[0].created_at + DAY_MS) }
      : undefined;
  }

  /** Read-only: lets the candidates answer say up front that only a +1 can go through today. */
  private peekDailyLimit(userId: string): DailyLimit | undefined {
    return this.dailyLimitAt(userId, this.now());
  }

  private reserveSlot(
    userId: string,
    title: string,
  ): { kind: 'reserved'; id: number } | Extract<FeatureRequestOutcome, { kind: 'daily_limit' }> {
    const now = this.now();
    return this.botDb.transaction(() => {
      const limited = this.dailyLimitAt(userId, now);
      if (limited) return { kind: 'daily_limit', ...limited };
      const result = this.botDb
        .stmt("INSERT INTO feature_requests (user_id, title, status, created_at) VALUES (?, ?, 'pending', ?)")
        .run(userId, title, now);
      return { kind: 'reserved', id: Number(result.lastInsertRowid) };
    });
  }

  /** Best-effort: a label that cannot be created must not block the request itself. */
  private async ensureLabels(): Promise<void> {
    if (this.ensuredLabelRepos.has(this.client.repo)) return;
    const results = await Promise.allSettled(LABEL_SPECS.map((label) => this.client.ensureLabel(label)));
    const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));
    const fatal = failures.find(isFatal);
    if (fatal) throw fatal;
    for (const failure of failures) {
      logger.warn('feature_request: could not ensure a GitHub label:', describeError(failure));
    }
    if (failures.length === 0) this.ensuredLabelRepos.add(this.client.repo);
  }

  private async createIssue(draft: IssueDraft, requester: IssueRequester, relatedTo?: number): Promise<GitHubIssue> {
    const input = {
      title: draft.title,
      body: renderIssueBody(draft, requester, { relatedTo }),
      labels: [...ISSUE_LABELS],
    };
    try {
      return await this.client.createIssue(input);
    } catch (error) {
      // GitHub validates labels on create; a 422 means nothing was created, so retrying once without them
      // (the labels are a convenience, the issue is the point) cannot duplicate anything.
      if (error instanceof GitHubApiError && error.kind === 'validation') {
        logger.warn('feature_request: issue rejected with labels, retrying without them:', error.message);
        return this.client.createIssue({ ...input, labels: [] });
      }
      throw error;
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
