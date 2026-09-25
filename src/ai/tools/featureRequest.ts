// request_feature: file a member's feature request as a GitHub issue on the bot's own repo. The repo is
// public today and the issue is written as public either way: should the owner make the repo private,
// nothing about what goes into an issue changes.
// The owner reviews it and, if approved, labels it `claude-implement`, which has Claude implement it in
// a PR (see src/github/featureRequests.ts and .github/workflows/claude-feature-request.yml).
//
// Tool results are read by the chat model, not by members: they state what happened and what to tell
// the person, and the model says it in character.
import type { Message } from 'discord.js';
import { config } from '../../config';
import { type FetchLike, type GitHubApiError, GitHubClient } from '../../github/client';
import { type FeatureRequestOutcome, FeatureRequestService } from '../../github/featureRequests';
import {
  CRITERIA_MAX_ITEMS,
  CRITERION_MAX_CHARS,
  DESCRIPTION_MAX_CHARS,
  type IssueDraft,
  WHY_MAX_CHARS,
  sanitizeInline,
  sanitizeMarkdown,
  sanitizeTitle,
  titleTokens,
} from '../../github/issueText';
import { logger } from '../../logger';
import { attributeMessage } from '../../relay';
import type { BotDb } from '../../storage/botDb';
import { logFailure } from '../failureLogger';
import type { ToolDefinition, ToolHandlerContext } from '../types';
import { formatTimestampET } from '../utils';

export type FeatureRequestToolDeps = {
  fetch?: FetchLike;
  now?: () => number;
  db?: BotDb;
  ensuredLabelRepos?: Set<string>;
};

const DESCRIPTION = [
  'File a feature request for this bot as a GitHub issue that the owner reviews before anything gets built.',
  'Only call it when someone explicitly asks for a bot feature or change to be filed or added',
  '("fridge, can you add…", "file a feature request for…", "make it so you can…") — never on your own initiative,',
  'for jokes, or for idle wishes. Treat the issue as PUBLIC on GitHub: write the title and fields as a clear,',
  'self-contained spec of the feature only. Never include chat transcripts, quotes, other members’ names or',
  'messages, or anything personal or private; the requester’s display name and a link to their message are',
  'added automatically. Returns the issue link to share, the existing issue when the same thing was already',
  'requested, or why it was not filed.',
].join(' ');

const PARAMETERS = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Short imperative title naming the feature, e.g. "Add a remindme command". Under 100 characters.',
    },
    description: {
      type: 'string',
      description:
        'What the feature should do, written as a spec: the behavior, how it is triggered, and edge cases. Markdown allowed.',
    },
    why: {
      type: 'string',
      description: 'Optional: the motivation, in general terms (no names, no quotes).',
    },
    acceptance_criteria: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional: 1–6 concrete, checkable criteria for "done".',
    },
  },
  required: ['title', 'description'],
  additionalProperties: false,
} as const;

function optionalString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Accepts the documented array, or a newline/bullet list the model sometimes sends as one string. */
function parseCriteria(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\n') : [];
  return items
    .flatMap((item) =>
      typeof item === 'string' ? [item.replace(/^\s*(?:[-*•]\s*(?:\[[ xX]?\]\s*)?|\d+[.)]\s*)/, '')] : [],
    )
    .map((item) => sanitizeInline(item, CRITERION_MAX_CHARS))
    .filter((item) => item.length > 0)
    .slice(0, CRITERIA_MAX_ITEMS);
}

type ParsedDraft = { ok: true; draft: IssueDraft } | { ok: false; reason: string };

function parseDraft(args: Record<string, unknown>): ParsedDraft {
  const title = sanitizeTitle(optionalString(args.title) ?? '');
  if (titleTokens(title).size === 0) {
    return { ok: false, reason: 'Not filed: the title was empty. Call again with a short title naming the feature.' };
  }
  const description = sanitizeMarkdown(optionalString(args.description) ?? '', DESCRIPTION_MAX_CHARS);
  if (description.length === 0) {
    return {
      ok: false,
      reason: 'Not filed: the description was empty. Call again describing what the feature should do.',
    };
  }
  const whyText = optionalString(args.why);
  return {
    ok: true,
    draft: {
      title,
      description,
      why: whyText ? sanitizeMarkdown(whyText, WHY_MAX_CHARS) || undefined : undefined,
      acceptanceCriteria: parseCriteria(args.acceptance_criteria),
    },
  };
}

/** The Discord link to the message that asked (discord.js builds it; a partial object falls back to ids). */
function jumpUrl(message: Message): string {
  if (typeof message.url === 'string' && message.url.startsWith('https://discord.com/channels/')) return message.url;
  const channelId = message.channelId || message.channel?.id;
  return `https://discord.com/channels/${message.guildId ?? '@me'}/${channelId}/${message.id}`;
}

function describeOutcome(outcome: FeatureRequestOutcome, requesterName: string): string {
  switch (outcome.kind) {
    case 'filed':
      return `Filed as GitHub issue #${outcome.issue.number}: ${outcome.issue.htmlUrl}\nShare the link with them. The owner reviews every request before anything gets built, so don't promise that it will ship or when.`;
    case 'duplicate':
      // Anyone can open issues on the public repo: the matched title is quoted as one capped line.
      return `Not filed again: this matches an open request, issue #${outcome.issue.number} "${sanitizeTitle(outcome.issue.title)}": ${outcome.issue.htmlUrl}\nShare that link instead; they can back it there with a 👍 or a comment.`;
    case 'not_allowed':
      return `Not filed: filing feature requests is limited to a few members right now, and ${requesterName} isn't one of them. Tell them to ask one of those members or the owner.`;
    case 'daily_limit':
      return `Not filed: ${requesterName} already filed ${outcome.limit} feature request${outcome.limit === 1 ? '' : 's'} in the last 24 hours, which is the limit. The next one can be filed after ${formatTimestampET(outcome.nextSlotAt)} ET.`;
    case 'github_error':
      return describeGitHubError(outcome.error);
  }
}

function describeGitHubError(error: GitHubApiError): string {
  // Configuration problems only the owner can fix: logged loudly and into self-diagnosis, so the weekly
  // digest surfaces them even if nobody mentions the failed request.
  const ownerFix: Partial<Record<GitHubApiError['kind'], string>> = {
    auth: "GitHub rejected the bot's token (expired or revoked), so the owner needs to renew GITHUB_TOKEN",
    forbidden: "the bot's GitHub token isn't allowed to create issues, so the owner needs to fix its permissions",
    not_found: "the bot's GitHub token can't see the configured repo, so the owner needs to check GITHUB_REPO",
    disabled: 'issues are turned off on the GitHub repo, so the owner needs to enable them',
    validation: 'GitHub rejected the issue as invalid, so the owner needs to look at the logs',
  };
  const fix = ownerFix[error.kind];
  if (fix) {
    logger.error(`request_feature: ${error.message}`);
    logFailure('tool_error', `request_feature could not file an issue (${error.kind}, HTTP ${error.status ?? '?'}).`);
    return `Not filed: ${fix}. Tell them it didn't go through and that it's on the owner's side.`;
  }

  logger.warn(`request_feature: ${error.message}`);
  if (error.kind === 'rate_limited') {
    const minutes = error.retryAfterSeconds ? Math.max(1, Math.ceil(error.retryAfterSeconds / 60)) : undefined;
    return `Not filed: GitHub is rate-limiting the bot right now. Tell them to try again ${minutes ? `in about ${minutes} minute${minutes === 1 ? '' : 's'}` : 'in a bit'}.`;
  }
  if (error.kind === 'timeout') {
    return "Not filed: GitHub didn't answer in time. Tell them to try again later; if it did go through, the retry will find the existing issue instead of filing it twice.";
  }
  return "Not filed: GitHub couldn't be reached right now. Tell them to try again later.";
}

export function createFeatureRequestTool(deps: FeatureRequestToolDeps = {}): ToolDefinition {
  return {
    name: 'request_feature',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    isEnabled: () => config.featureRequests.enabled,
    handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
      const token = config.featureRequests.githubToken;
      const repo = config.featureRequests.githubRepo;
      if (!token || !repo) {
        return "Feature requests aren't set up on this bot (no GitHub connection). Tell them to ask the owner directly.";
      }

      const attribution = attributeMessage(ctx.message);
      if (!attribution?.authorId) {
        return "Not filed: couldn't tell which member is asking. Only a member's own message can file a request.";
      }

      const parsed = parseDraft(args);
      if (!parsed.ok) return parsed.reason;

      const service = new FeatureRequestService({
        client: new GitHubClient({ token, repo, fetch: deps.fetch }),
        maxPerDay: config.featureRequests.maxPerDay,
        allowedUserIds: config.featureRequests.userIds,
        db: deps.db,
        now: deps.now,
        ensuredLabelRepos: deps.ensuredLabelRepos,
      });
      const outcome = await service.submit(parsed.draft, {
        userId: attribution.authorId,
        displayName: attribution.authorName,
        jumpUrl: jumpUrl(ctx.message),
      });
      return describeOutcome(outcome, attribution.authorName);
    },
  };
}

export const featureRequestTools: ToolDefinition[] = [createFeatureRequestTool()];
