// Spontaneous reactions: now and then the bot adds one emoji to a post that genuinely stands out, the way
// the group reacts to each other, without replying. The owner's brief: "not often, only when it's a real
// good one", and it has to learn how the group reacts first.
//
// Pipeline, per member post in AUTO_REACT_CHANNELS:
//   1. intake (sync, free): not the bot, not other bots, not a post addressed to the bot (those get a
//      reply, see candidate.ts); each candidate waits AUTO_REACT_DELAY_SECONDS so link previews resolve
//      and a quick delete or the link fixer's repost lands first.
//   2. before spending a model call: still there, attributable to a member (relays included), not
//      replied to or reacted to by the bot (a relay: nor its original), the author isn't mid-exchange
//      with the bot (the gate's own notion, asked through `inExchange`: a partner's follow-up is the
//      gate's to answer), the budget has room, and the archive has taught enough (learn first).
//   3. the judge (judge.ts) sees the post, its images and preview text, a few messages of context and the
//      reaction guide (guide.ts), and answers react / emoji / why.
//   4. the emoji must exist (server emoji or unicode); the budget slot is claimed synchronously, then
//      'on' reacts and 'shadow' only posts what it would have done to the report channel.
import type { EmojiRow } from '../ai/memory/memoryStore';
import { resolveReactionEmoji } from '../ai/tools/react';
import { logger } from '../logger';
import type { ReactionGuide } from './guide';
import type { AutoReactJudge, ContextLine } from './judge';
import type { AutoReactLedger, BudgetLimits } from './ledger';

export type AutoReactMode = 'off' | 'shadow' | 'on';

export type AutoReactSettings = {
  mode: AutoReactMode;
  maxPerDay: number;
  minGapMs: number;
  minProfileMessages: number;
  delayMs: number;
};

/** What the judge is shown about the post, read after the debounce (embeds and reactions have landed). */
export type CandidateSnapshot = {
  authorId?: string;
  authorName: string;
  /** The text with custom emoji tokens made readable. */
  text: string;
  /** Attachments, stickers, link previews, embeds, reactions so far: one short line each. */
  notes: string[];
  /** Discord-hosted image URLs worth showing the judge, most relevant first. */
  imageUrls: string[];
  /** The bot already reacted to it (e.g. through the react tool in a chat turn). */
  botReacted: boolean;
};

/** One post under consideration. The Discord adapter is in candidate.ts; tests build these directly. */
export type Candidate = {
  id: string;
  channelId: string;
  url: string;
  createdAt: number;
  /**
   * For the bot's relay of a member's post (a link fix, a regret repost): the id of the message it stands
   * in for, read at evaluation time (the relay is recorded only once its send returns). The agent answers
   * and the bot reacts to that original by its own id, and the same post must not get both.
   */
  originalId?: () => string | undefined;
  /** undefined ⇒ not a member's post after all (another bot's or integration's webhook). */
  snapshot(): CandidateSnapshot | undefined;
  /** Up to `limit` messages right before the post, oldest first. */
  context(limit: number): ContextLine[];
  react(emoji: string): Promise<void>;
};

export type EvaluationOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'no_reaction'; why: string }
  | { status: 'invalid_emoji'; emoji: string | undefined; why: string }
  | { status: 'reacted' | 'shadow'; emoji: string; why: string }
  | { status: 'failed'; emoji: string; error: string };

export type AutoReactorDeps = {
  settings: () => AutoReactSettings;
  judge: AutoReactJudge;
  /** The (cached) reaction guide; `minReacted` picks the cache TTL (see ReactionGuideCache). */
  guide: (minReacted: number) => ReactionGuide;
  ledger: AutoReactLedger;
  /** The server's usable custom emojis (the emoji table). */
  emojis: () => EmojiRow[];
  /** Downloads and downscales up to `max` images; failures are left out. */
  loadImages: (urls: string[], max: number) => Promise<string[]>;
  /** Posts a line to the report channel (a no-op when none is configured). */
  report: (text: string) => Promise<void>;
  /**
   * Whether the post was handed to the agent for an answer (the gate's wasRouted). Covers a turn whose
   * reply hasn't been posted yet, and a gate-routed follow-up from a partner answered earlier on.
   */
  wasRouted?: (messageId: string) => boolean;
  /**
   * Whether the author is a partner in the bot's active exchange in that channel (the gate's
   * isInExchange): their follow-ups are the gate's to answer, so they are not reacted to meanwhile.
   */
  inExchange?: (channelId: string, userId: string) => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

const CONTEXT_MESSAGES = 6;
const MAX_IMAGES = 2;
// Posts waiting out the delay. A flood beyond this is not worth judging one by one.
const MAX_PENDING = 50;
// How long the bot's replies are remembered ("the bot replied to it").
const REPLY_MEMORY_MS = 30 * 60 * 1000;
const TALLY_PERIOD_MS = 24 * 60 * 60 * 1000;

type BotReply = { repliedToId: string; at: number };

/** Model- and member-written text in a report line must never ping anyone (@everyone, @someone). */
function noPings(text: string): string {
  return text.replace(/@/g, '@\u200b');
}

export class AutoReactor {
  private readonly deps: AutoReactorDeps;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly pending = new Map<string, unknown>();
  private readonly cancelled = new Set<string>();
  private readonly botReplies = new Map<string, BotReply[]>();
  private readonly running = new Set<Promise<EvaluationOutcome>>();
  private learningLogged = false;
  private tally = { since: 0, judged: 0, reactions: 0 };

  constructor(deps: AutoReactorDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return timer;
      });
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.tally.since = this.now();
  }

  /** Queues a post that passed intake; it is evaluated once the delay has passed. */
  observe(candidate: Candidate): void {
    const settings = this.deps.settings();
    if (settings.mode === 'off') return;
    if (this.pending.has(candidate.id)) return;
    if (this.pending.size >= MAX_PENDING) {
      logger.debug(`autoReact: ${this.pending.size} posts already waiting; skipping ${candidate.id}`);
      return;
    }
    const timer = this.setTimer(() => {
      this.pending.delete(candidate.id);
      const run = this.evaluate(candidate);
      this.running.add(run);
      void run.finally(() => this.running.delete(run));
    }, settings.delayMs);
    this.pending.set(candidate.id, timer);
  }

  /** The post was deleted: drop it if it's waiting, and never react to it. */
  cancel(messageId: string): void {
    const timer = this.pending.get(messageId);
    if (timer !== undefined) {
      this.clearTimer(timer);
      this.pending.delete(messageId);
    }
    this.cancelled.add(messageId);
    // Bounded: deletions are only remembered long enough to cover an evaluation in flight.
    if (this.cancelled.size > 500) this.cancelled.delete(this.cancelled.values().next().value as string);
  }

  /** The bot posted in a channel; a reply marks its target as answered (never also reacted to). */
  noteBotMessage(channelId: string, reply: { repliedToId?: string }): void {
    if (!reply.repliedToId) return;
    const now = this.now();
    const list = (this.botReplies.get(channelId) ?? []).filter((r) => now - r.at < REPLY_MEMORY_MS);
    list.push({ repliedToId: reply.repliedToId, at: now });
    this.botReplies.set(channelId, list);
  }

  /** Posts currently waiting out the delay (for tests and logs). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Resolves when every evaluation in flight has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  /** The post's id, plus the original's for a relay: an answer or a reaction to either counts for both. */
  private postIds(candidate: Candidate): string[] {
    const originalId = candidate.originalId?.();
    return originalId && originalId !== candidate.id ? [candidate.id, originalId] : [candidate.id];
  }

  private botRepliedTo(candidate: Candidate, ids: string[]): boolean {
    const replies = this.botReplies.get(candidate.channelId) ?? [];
    return ids.some((id) => this.deps.wasRouted?.(id) || replies.some((r) => r.repliedToId === id));
  }

  private inExchange(candidate: Candidate, authorId: string | undefined): boolean {
    return authorId !== undefined && (this.deps.inExchange?.(candidate.channelId, authorId) ?? false);
  }

  private budgetLimits(settings: AutoReactSettings): BudgetLimits {
    return { maxPerDay: settings.maxPerDay, minGapMs: settings.minGapMs };
  }

  private noteTally(reacted: boolean): void {
    const now = this.now();
    if (now - this.tally.since >= TALLY_PERIOD_MS) {
      logger.info(
        `autoReact: last 24 h: judged ${this.tally.judged} post(s), ${this.tally.reactions} reaction(s) (${this.deps.settings().mode})`,
      );
      this.tally = { since: now, judged: 0, reactions: 0 };
    }
    this.tally.judged++;
    if (reacted) this.tally.reactions++;
  }

  /** Every check after the delay, the judge, and the reaction itself. Never throws. */
  async evaluate(candidate: Candidate): Promise<EvaluationOutcome> {
    try {
      const outcome = await this.evaluateUnsafe(candidate);
      if (outcome.status === 'skipped') logger.debug(`autoReact: skipped ${candidate.id}: ${outcome.reason}`);
      return outcome;
    } catch (error) {
      logger.warn(`autoReact: evaluating ${candidate.id} failed:`, error);
      return { status: 'skipped', reason: 'error' };
    }
  }

  private async evaluateUnsafe(candidate: Candidate): Promise<EvaluationOutcome> {
    const settings = this.deps.settings();
    if (settings.mode === 'off') return { status: 'skipped', reason: 'off' };
    if (this.cancelled.has(candidate.id)) return { status: 'skipped', reason: 'deleted' };
    // Only the post's own deletion counts: a relay's original is always gone (that's what a relay is).
    const ids = this.postIds(candidate);
    if (this.botRepliedTo(candidate, ids)) return { status: 'skipped', reason: 'bot replied' };
    if (ids.some((id) => this.deps.ledger.has(id))) return { status: 'skipped', reason: 'already reacted' };

    const snapshot = candidate.snapshot();
    if (!snapshot) return { status: 'skipped', reason: 'not a member post' };
    if (snapshot.botReacted) return { status: 'skipped', reason: 'bot already reacted' };
    if (this.inExchange(candidate, snapshot.authorId)) {
      return { status: 'skipped', reason: 'author is talking with the bot' };
    }

    // Budget first: a post the bot couldn't react to anyway isn't worth a model call.
    const budget = this.deps.ledger.check(this.now(), this.budgetLimits(settings));
    if (!budget.allowed) return { status: 'skipped', reason: `budget (${budget.reason})` };

    const guide = this.deps.guide(settings.minProfileMessages);
    if (guide.reactedMessages < settings.minProfileMessages) {
      if (!this.learningLogged) {
        logger.info(
          `autoReact: still learning: the archive has ${guide.reactedMessages}/${settings.minProfileMessages} reacted posts; not judging yet`,
        );
        this.learningLogged = true;
      }
      return { status: 'skipped', reason: 'learning' };
    }
    this.learningLogged = false;

    const images = snapshot.imageUrls.length > 0 ? await this.deps.loadImages(snapshot.imageUrls, MAX_IMAGES) : [];
    const verdict = await this.deps.judge({
      guide,
      context: candidate.context(CONTEXT_MESSAGES),
      post: { author: snapshot.authorName, text: snapshot.text, notes: snapshot.notes, images },
    });
    if (!verdict) return { status: 'skipped', reason: 'no verdict' };
    if (!verdict.react) {
      this.noteTally(false);
      logger.debug(`autoReact: no reaction for ${candidate.id}: ${verdict.why}`);
      return { status: 'no_reaction', why: verdict.why };
    }

    const resolved = verdict.emoji ? resolveReactionEmoji(verdict.emoji, this.deps.emojis()) : undefined;
    if (!resolved) {
      this.noteTally(false);
      logger.warn(`autoReact: the judge picked an emoji that doesn't exist ("${verdict.emoji ?? ''}"); not reacting`);
      return { status: 'invalid_emoji', emoji: verdict.emoji, why: verdict.why };
    }

    // The model call took a while: re-check what may have changed meanwhile, then claim the budget slot
    // synchronously, so two decisions finishing together can't both spend the last one.
    if (this.cancelled.has(candidate.id)) return { status: 'skipped', reason: 'deleted' };
    if (this.botRepliedTo(candidate, ids)) return { status: 'skipped', reason: 'bot replied' };
    const again = this.deps.ledger.check(this.now(), this.budgetLimits(settings));
    if (!again.allowed) return { status: 'skipped', reason: `budget (${again.reason})` };
    const mode = settings.mode;
    const claimed = this.deps.ledger.claim({
      messageId: candidate.id,
      channelId: candidate.channelId,
      emoji: resolved.label,
      why: verdict.why,
      mode,
      createdAt: this.now(),
    });
    if (!claimed) return { status: 'skipped', reason: 'already reacted' };

    if (mode === 'on') {
      try {
        await candidate.react(resolved.emoji);
      } catch (error) {
        this.deps.ledger.release(candidate.id);
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`autoReact: reacting ${resolved.label} to ${candidate.url} failed: ${message}`);
        return { status: 'failed', emoji: resolved.label, error: message };
      }
      this.noteTally(true);
      logger.info(`autoReact: reacted ${resolved.label} to ${candidate.url} (${snapshot.authorName}): ${verdict.why}`);
      return { status: 'reacted', emoji: resolved.label, why: verdict.why };
    }

    this.noteTally(true);
    logger.info(
      `autoReact (shadow): would react ${resolved.label} to ${candidate.url} (${snapshot.authorName}): ${verdict.why}`,
    );
    await this.deps.report(
      `-# auto-react (shadow) · would react ${resolved.label} to ${noPings(snapshot.authorName)}'s post ${candidate.url}\n-# why: ${noPings(verdict.why) || '(no reason given)'}`,
    );
    return { status: 'shadow', emoji: resolved.label, why: verdict.why };
  }
}
