// Members ask the bot for a feature → it files a GitHub issue → the owner approves it by adding the
// `claude-implement` label → a GitHub Actions workflow has Claude implement it in a PR
// (.github/workflows/claude-feature-request.yml).
//
// This module is the filing half: allowlist, per-member daily cap (bot.db), duplicate detection against
// the open issues, and issue creation. It never applies `claude-implement`: the bot's token belongs to
// the repo owner, so a label it applied would look exactly like the owner's approval to the workflow.
// The label set below is fixed in code for that reason; nothing the model writes can extend it.
import { logger } from '../logger';
import { type BotDb, getBotDb } from '../storage/botDb';
import { GitHubApiError, type GitHubErrorKind, type GitHubIssue, type GitHubIssuesApi, type LabelSpec } from './client';
import { type IssueDraft, type IssueRequester, findDuplicate, renderIssueBody } from './issueText';

export const FEATURE_REQUEST_LABEL = 'feature-request';
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

// Failures that doom the whole request wherever they happen: the best-effort steps (labels, duplicate
// check) stop on them instead of carrying on into a create that would fail the same way.
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

export type FeatureRequestOutcome =
  | { kind: 'filed'; issue: GitHubIssue }
  | { kind: 'duplicate'; issue: GitHubIssue }
  | { kind: 'not_allowed' }
  | { kind: 'daily_limit'; limit: number; nextSlotAt: Date }
  | { kind: 'github_error'; error: GitHubApiError };

export type FeatureRequestServiceOptions = {
  client: GitHubIssuesApi;
  maxPerDay: number;
  /** Discord user ids allowed to file; empty ⇒ everyone. */
  allowedUserIds: readonly string[];
  db?: BotDb;
  now?: () => number;
  /** Repos whose labels were already ensured in this process (shared across service instances). */
  ensuredLabelRepos?: Set<string>;
};

export type FeatureRequester = IssueRequester & { userId: string };

const defaultEnsuredLabelRepos = new Set<string>();

export class FeatureRequestService {
  private readonly client: GitHubIssuesApi;
  private readonly maxPerDay: number;
  private readonly allowedUserIds: readonly string[];
  private readonly botDb: BotDb;
  private readonly now: () => number;
  private readonly ensuredLabelRepos: Set<string>;

  constructor(opts: FeatureRequestServiceOptions) {
    this.client = opts.client;
    this.maxPerDay = opts.maxPerDay;
    this.allowedUserIds = opts.allowedUserIds;
    this.botDb = opts.db ?? getBotDb();
    this.now = opts.now ?? Date.now;
    this.ensuredLabelRepos = opts.ensuredLabelRepos ?? defaultEnsuredLabelRepos;
    this.botDb.ensureSchema('feature_requests', SCHEMA);
  }

  /** `draft` must already be sanitized (see issueText.ts). */
  async submit(draft: IssueDraft, requester: FeatureRequester): Promise<FeatureRequestOutcome> {
    if (this.allowedUserIds.length > 0 && !this.allowedUserIds.includes(requester.userId)) {
      return { kind: 'not_allowed' };
    }

    // The slot is reserved synchronously (check + insert in one transaction) before the first await,
    // so two requests racing in different channels cannot both squeeze under the cap. It is released
    // again when nothing gets filed; a crash mid-request leaves it counted, which errs on the safe side.
    const reservation = this.reserveSlot(requester.userId, draft.title);
    if (reservation.kind === 'daily_limit') return reservation;

    let filed = false;
    try {
      await this.ensureLabels();

      const duplicate = await this.findOpenDuplicate(draft.title);
      if (duplicate) {
        logger.info(`feature_request duplicate user=${requester.userId} issue=#${duplicate.number}`);
        return { kind: 'duplicate', issue: duplicate };
      }

      const issue = await this.createIssue(draft, requester);
      // The issue exists from here on, whatever happens to the bookkeeping: the slot stays taken.
      filed = true;
      logger.info(`feature_request filed user=${requester.userId} issue=#${issue.number}`);
      try {
        this.botDb
          .stmt("UPDATE feature_requests SET status = 'filed', issue_number = ?, issue_url = ? WHERE id = ?")
          .run(issue.number, issue.htmlUrl, reservation.id);
      } catch (error) {
        logger.warn(`feature_request: issue #${issue.number} filed but not recorded:`, describeError(error));
      }
      return { kind: 'filed', issue };
    } catch (error) {
      if (error instanceof GitHubApiError) return { kind: 'github_error', error };
      throw error;
    } finally {
      if (!filed) this.botDb.stmt('DELETE FROM feature_requests WHERE id = ?').run(reservation.id);
    }
  }

  private reserveSlot(
    userId: string,
    title: string,
  ): { kind: 'reserved'; id: number } | Extract<FeatureRequestOutcome, { kind: 'daily_limit' }> {
    const now = this.now();
    return this.botDb.transaction(() => {
      const recent = this.botDb
        .stmt('SELECT created_at FROM feature_requests WHERE user_id = ? AND created_at > ? ORDER BY created_at ASC')
        .all(userId, now - DAY_MS) as Array<{ created_at: number }>;
      if (recent.length >= this.maxPerDay) {
        // The oldest request in the window is the first to age out of it.
        return { kind: 'daily_limit', limit: this.maxPerDay, nextSlotAt: new Date(recent[0].created_at + DAY_MS) };
      }
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

  /** Best-effort as well: when listing fails transiently, filing a possible duplicate beats not filing. */
  private async findOpenDuplicate(title: string): Promise<GitHubIssue | undefined> {
    try {
      return findDuplicate(title, await this.client.listOpenIssues());
    } catch (error) {
      if (isFatal(error)) throw error;
      logger.warn('feature_request: duplicate check skipped, listing open issues failed:', describeError(error));
      return undefined;
    }
  }

  private async createIssue(draft: IssueDraft, requester: IssueRequester): Promise<GitHubIssue> {
    const input = { title: draft.title, body: renderIssueBody(draft, requester), labels: [...ISSUE_LABELS] };
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
