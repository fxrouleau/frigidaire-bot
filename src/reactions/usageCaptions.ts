// Emoji captions grounded in how the group actually uses each emoji. A caption reads "<visual>; for
// <meaning>", and the first-pass captioner (src/ai/emojiCaptioner.ts) can only guess the meaning from
// the name and image, i.e. the generic internet meaning. Prod showed where that goes wrong: an emoji
// captioned "sadness/pleading" is used as a resigned "bruh" at absurd moments; one captioned "deep
// thought" is used for meh/underwhelmed/annoyed. This job keeps each caption's visual half and rewrites
// the meaning half from real uses in the archive (reactions + typed uses, emojiUsage.ts), using the
// caption model.
//
// When: weekly (and EMOJI_RECAPTION_FROM_USAGE=1 forces a full pass at startup). Most weeks rewrite
// nothing: an emoji is only re-grounded when it has never been, when its caption was replaced since (a
// rename re-captions it from the image, EMOJI_FORCE_RECAPTION clears everything), or when its uses grew
// by half since. That keeps the Opus-priced caption model to a handful of calls a week.
//
// Not while the archive is still importing history (a fresh archive's backfill runs for hours or days):
// the uses would be counted from the first few pages and the week-long watermark would then hold most
// emojis to that. Scheduled checks wait for the import to finish; a forced pass runs anyway but leaves
// the watermark alone, so the first check after the import does a real pass.
import { composeCaption, describeEmojiUsage, splitCaption, type UsagePhraseInput } from '../ai/emojiCaptioner';
import { getMemoryStore } from '../ai/memory';
import type { EmojiRow, MemoryStore } from '../ai/memory/memoryStore';
import { type ArchiveStore, getArchiveStore } from '../archive/archiveStore';
import { isArchiveImportInProgress } from '../archive/backfill';
import { config } from '../config';
import { logger } from '../logger';
import { type BotDb, getBotDb } from '../storage/botDb';
import { collectEmojiUsage, type EmojiUsage, formatUsageSample } from './emojiUsage';

/** Uses (reactions + messages) an emoji needs before its usage says anything. */
export const MIN_USES = 5;
export const MAX_SAMPLES = 20;
/** Emojis re-grounded per weekly run (a forced run does them all). */
export const MAX_PER_RUN = 40;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Re-ground when uses grew by half and by at least this many since the last grounding.
const GROWTH_FACTOR = 1.5;
const GROWTH_MIN = 10;
// Consecutive failed calls after which a run gives up (the model or OpenRouter is down): the next check retries.
const MAX_CONSECUTIVE_FAILURES = 3;
// Give the archive's startup gap fill (and the emoji sync's own captioning) time to finish first.
const STARTUP_DELAY_MS = 10 * 60 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const JOB_NAME = 'emoji_usage_captions';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS emoji_usage_captions (
    emoji_id   TEXT    PRIMARY KEY,
    uses       INTEGER NOT NULL,
    caption    TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reaction_jobs (
    name        TEXT    PRIMARY KEY,
    last_run_at INTEGER NOT NULL
  );
`;

export type UsageCaptionDeps = {
  memory?: () => MemoryStore;
  archive?: () => ArchiveStore;
  botDb?: () => BotDb;
  describe?: (input: UsagePhraseInput) => Promise<string | undefined>;
  now?: () => number;
  /** True while the archive is still importing history (default: the running archive sync says so). */
  importing?: () => boolean;
};

export type RecaptionResult = {
  /** Emojis with enough uses to ground. */
  eligible: number;
  /** Of those, due for (re-)grounding. */
  due: number;
  updated: number;
  failed: number;
  /** The run gave up after repeated failures (the watermark was not advanced). */
  aborted: boolean;
  /** The archive was still importing history: uses were counted from part of it (the watermark was not advanced). */
  partial: boolean;
};

type GroundedRow = { emoji_id: string; uses: number; caption: string; updated_at: number };

function db(deps: UsageCaptionDeps): BotDb {
  const botDb = (deps.botDb ?? getBotDb)();
  botDb.ensureSchema(JOB_NAME, SCHEMA);
  return botDb;
}

export function lastRunAt(deps: UsageCaptionDeps = {}): number | undefined {
  const row = db(deps).stmt('SELECT last_run_at FROM reaction_jobs WHERE name = ?').get(JOB_NAME) as
    | { last_run_at: number }
    | undefined;
  return row?.last_run_at;
}

function recordRun(deps: UsageCaptionDeps, at: number): void {
  db(deps)
    .stmt(
      `INSERT INTO reaction_jobs (name, last_run_at) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at`,
    )
    .run(JOB_NAME, at);
}

function groundedRows(deps: UsageCaptionDeps): Map<string, GroundedRow> {
  const rows = db(deps).stmt('SELECT * FROM emoji_usage_captions').all() as GroundedRow[];
  return new Map(rows.map((row) => [row.emoji_id, row]));
}

function saveGrounded(deps: UsageCaptionDeps, emojiId: string, uses: number, caption: string, at: number): void {
  db(deps)
    .stmt(
      `INSERT INTO emoji_usage_captions (emoji_id, uses, caption, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(emoji_id) DO UPDATE SET uses = excluded.uses, caption = excluded.caption, updated_at = excluded.updated_at`,
    )
    .run(emojiId, uses, caption, at);
}

/** Whether an emoji's caption should be (re-)grounded now (see the file comment). */
export function isDue(emoji: EmojiRow, usage: EmojiUsage, grounded: GroundedRow | undefined): boolean {
  if (!grounded) return true;
  if (grounded.caption !== emoji.caption) return true;
  return usage.total >= grounded.uses * GROWTH_FACTOR && usage.total - grounded.uses >= GROWTH_MIN;
}

/** One pass: ground every due emoji (all eligible ones with `force`). Never throws. */
export async function runUsageRecaption(
  opts: { force?: boolean } = {},
  deps: UsageCaptionDeps = {},
): Promise<RecaptionResult> {
  const result: RecaptionResult = { eligible: 0, due: 0, updated: 0, failed: 0, aborted: false, partial: false };
  const now = deps.now ?? Date.now;
  const describe = deps.describe ?? describeEmojiUsage;
  try {
    result.partial = (deps.importing ?? isArchiveImportInProgress)();
    const memory = (deps.memory ?? getMemoryStore)();
    // Only captioned emojis: the visual half comes from the first-pass caption.
    const emojis = memory.getUsableEmojis().filter((e) => e.caption);
    const usage = collectEmojiUsage(
      emojis.map((e) => e.id),
      { store: (deps.archive ?? getArchiveStore)(), maxSamples: MAX_SAMPLES },
    );
    const eligible = emojis
      .map((emoji) => ({ emoji, usage: usage.get(emoji.id) }))
      .filter((e): e is { emoji: EmojiRow; usage: EmojiUsage } => e.usage !== undefined && e.usage.total >= MIN_USES)
      .sort((a, b) => b.usage.total - a.usage.total || a.emoji.name.localeCompare(b.emoji.name));
    result.eligible = eligible.length;

    const grounded = groundedRows(deps);
    const due = eligible.filter((e) => opts.force || isDue(e.emoji, e.usage, grounded.get(e.emoji.id)));
    result.due = due.length;
    const batch = opts.force ? due : due.slice(0, MAX_PER_RUN);

    let consecutiveFailures = 0;
    for (const { emoji, usage: emojiUsage } of batch) {
      const caption = emoji.caption ?? '';
      const phrase = await describe({
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated === 1,
        caption,
        uses: emojiUsage.samples.map(formatUsageSample),
      });
      if (!phrase) {
        result.failed++;
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          result.aborted = true;
          break;
        }
        continue;
      }
      consecutiveFailures = 0;
      const next = composeCaption(splitCaption(caption).visual, phrase);
      if (next !== caption) {
        memory.setEmojiCaption(emoji.id, next);
        logger.info(`emojiUsageCaptions: ${emoji.name} (${emojiUsage.total} uses): "${caption}" → "${next}"`);
      }
      saveGrounded(deps, emoji.id, emojiUsage.total, next, now());
      result.updated++;
    }
    if (!result.aborted && !result.partial) recordRun(deps, now());
  } catch (error) {
    logger.warn('emojiUsageCaptions: run failed:', error);
    result.aborted = true;
  }
  const verb = result.aborted ? 'gave up' : 'done';
  logger.info(
    `emojiUsageCaptions: ${verb}: eligible=${result.eligible} due=${result.due} updated=${result.updated} failed=${result.failed}${opts.force ? ' (forced)' : ''}${result.partial ? ' (archive still importing: watermark not advanced)' : ''}`,
  );
  return result;
}

/**
 * Runs a pass when forced, or when the last one is a week old and the archive isn't importing history.
 * Undefined when nothing ran.
 */
export async function runUsageRecaptionIfDue(
  opts: { force?: boolean } = {},
  deps: UsageCaptionDeps = {},
): Promise<RecaptionResult | undefined> {
  const now = (deps.now ?? Date.now)();
  const last = lastRunAt(deps);
  if (!opts.force && last !== undefined && now - last < WEEK_MS) return undefined;
  if (!opts.force && (deps.importing ?? isArchiveImportInProgress)()) {
    logger.info('emojiUsageCaptions: the archive is still importing history; grounding waits for it to finish.');
    return undefined;
  }
  return runUsageRecaption(opts, deps);
}

let running = false;

async function guardedRun(force: boolean): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runUsageRecaptionIfDue({ force });
  } catch (error) {
    logger.warn('emojiUsageCaptions: scheduled run failed:', error);
  } finally {
    running = false;
  }
}

/**
 * Starts the schedule (called once the startup emoji sync has captioned everything): a first check a
 * few minutes after startup (forced when EMOJI_RECAPTION_FROM_USAGE is on), then every few hours for a
 * week-old watermark. Needs the archive and an OpenRouter key.
 */
export function scheduleUsageRecaption(): void {
  const force = config.emoji.recaptionFromUsage;
  const weekly = config.emoji.usageCaptionsEnabled;
  if (!force && !weekly) return;
  if (!config.archive.enabled || !config.openRouter.apiKey) {
    if (force) logger.warn('emojiUsageCaptions: EMOJI_RECAPTION_FROM_USAGE needs the archive and an OpenRouter key');
    return;
  }
  if (force) {
    logger.warn(
      'emojiUsageCaptions: EMOJI_RECAPTION_FROM_USAGE is on: every caption gets re-grounded shortly. Unset it again, or every restart repeats it.',
    );
  }
  setTimeout(() => void guardedRun(force), STARTUP_DELAY_MS).unref();
  if (weekly) setInterval(() => void guardedRun(false), CHECK_INTERVAL_MS).unref();
}
