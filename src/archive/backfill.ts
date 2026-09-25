// Importing history into the archive and keeping recent rows current, three ways:
//
// - Backfill: for each ARCHIVE_BACKFILL_CHANNELS channel, page backwards 100 messages at a time from
//   the oldest archived message to the start of the channel. Resumable: the cursor and a done flag live
//   in archive.db and advance in the same transaction as each page's rows, so a restart (the bot
//   redeploys on every merge) picks up exactly where it stopped.
// - Gap fill: after downtime, every channel with history is paged forward from its newest archived
//   message, so messages posted while the bot was offline are not missing. Channels whose last message
//   (as Discord reports it in the channel cache) is already archived cost no gap-fill request. The id a
//   channel's gap fill has reached is saved with each page: live ingest archives newer messages in the
//   meantime, so a run that stops early resumes from there instead of skipping the rest of the gap.
// - Refresh: reactions added or removed, edits and deletions made while the bot was offline never
//   arrive as events, and the reaction events that follow are deltas on the stored counts. So once per
//   process, each channel active within REFRESH_LOOKBACK_MS has its newest archived page re-read (one
//   request): Discord's data replaces the archived rows, archived messages missing from the page's span
//   are marked deleted, and messages the archive doesn't hold are not imported.
//
// All three are polite (ARCHIVE_BACKFILL_DELAY_MS between requests; discord.js additionally honors 429s),
// fetch with cache:false (hundreds of thousands of messages must not pile up in discord.js' cache), and
// treat missing access as "skip this channel, retry later" rather than an error loop.
import type { Client, Message } from 'discord.js';
import { config } from '../config';
import { logger } from '../logger';
import { type ArchiveStore, compareSnowflakes, getArchiveStore } from './archiveStore';
import {
  type ArchivableChannelLike,
  channelInfoOf,
  isArchivableChannel,
  isIgnoredChannel,
  reconcileRelays,
  refreshTranscripts,
  toArchiveInput,
} from './ingest';

const PAGE_SIZE = 100;
const PROGRESS_EVERY_PAGES = 25;
const MAX_ATTEMPTS = 4;
// A channel whose backfill failed (no access, deleted, persistent errors) is retried after this long.
const ERROR_RETRY_MS = 60 * 60 * 1000;
// Channels whose newest archived message is older than this are not refreshed after a restart: a
// reaction during the downtime on a message that old is unlikely enough not to be worth a request.
const REFRESH_LOOKBACK_MS = 7 * 86_400_000;
// Discord API error codes that mean "this channel is not readable", not "try again".
const PERMANENT_DISCORD_CODES = new Set([10003, 50001, 50013]);

/** A channel the sync can read history from; built from a discord.js text channel in production. */
export type HistorySource = ArchivableChannelLike & {
  /** When Discord created the channel: the far end of the backfill, for progress estimates. */
  createdTimestamp?: number | null;
  /** The newest message id Discord knows for this channel (channel cache), if any. */
  lastMessageId?: string | null;
  fetchPage(options: { before?: string; after?: string; limit: number }): Promise<Message[]>;
};

export type ArchiveSyncDeps = {
  store: () => ArchiveStore;
  /** Resolves a channel for reading, fetching it from the API when needed. */
  resolveChannel: (id: string) => Promise<HistorySource | undefined>;
  /** A channel from the local cache only (no API call); used to skip up-to-date channels in gap fill. */
  peekChannel: (id: string) => HistorySource | undefined;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  delayMs: () => number;
  backfillChannelIds: () => string[];
};

export type SyncStatus = { running: boolean; phase: 'idle' | 'gap_fill' | 'backfill' };

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

function isPermanentError(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== undefined && PERMANENT_DISCORD_CODES.has(code)) return true;
  const status = errorStatus(error);
  return status === 403 || status === 404;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Oldest and newest message of a page by snowflake order (the API's array order is not relied on). */
function pageBounds(messages: Message[]): { oldest: Message; newest: Message } | undefined {
  if (messages.length === 0) return undefined;
  let oldest = messages[0];
  let newest = messages[0];
  for (const m of messages) {
    if (compareSnowflakes(m.id, oldest.id) < 0) oldest = m;
    if (compareSnowflakes(m.id, newest.id) > 0) newest = m;
  }
  return { oldest, newest };
}

export class ArchiveSync {
  private running = false;
  private phase: SyncStatus['phase'] = 'idle';
  private stopped = false;
  private requestsMade = 0;
  /** Channels whose newest archived page this process has re-read (see refreshNewest). */
  private readonly refreshed = new Set<string>();

  constructor(private readonly deps: ArchiveSyncDeps) {}

  status(): SyncStatus {
    return { running: this.running, phase: this.phase };
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Gap fill, then backfill. Returns false (and does nothing) when a run is already in progress, so
   * the periodic resume can call it freely.
   */
  async run(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      this.phase = 'gap_fill';
      await this.gapFill();
      this.phase = 'backfill';
      await this.backfill();
      return true;
    } finally {
      this.phase = 'idle';
      this.running = false;
    }
  }

  /**
   * Pages forward from each channel's newest archived message to catch what was posted while offline,
   * and finishes gap fills an earlier run left unfinished from where they stopped. Recently active
   * channels also get their newest archived page refreshed, once per process (see refreshNewest).
   */
  async gapFill(): Promise<number> {
    const store = this.deps.store();
    // Read before the first await: live ingest is already archiving newer messages.
    const history = store.channelsWithHistory();
    const starts = new Map(history.map((c) => [c.channelId, c.newestId]));
    const now = this.deps.now();
    const toRefresh = new Map(
      history
        .filter((c) => now - c.newestAt < REFRESH_LOOKBACK_MS && !this.refreshed.has(c.channelId))
        .map((c) => [c.channelId, c.newestId]),
    );
    const pending = store.pendingGapFills();
    for (const { channelId, cursorId } of pending) starts.set(channelId, cursorId);
    const pendingIds = new Set(pending.map((p) => p.channelId));
    let total = 0;
    const refreshed = { changed: 0, deleted: 0 };
    for (const [channelId, from] of starts) {
      if (this.stopped) break;
      const cached = this.deps.peekChannel(channelId);
      // Not in the channel cache: deleted, no longer visible, or an archived thread (a new message
      // would have unarchived it, putting it back in the cache). Nothing to catch up on.
      if (!cached || !isArchivableChannel(cached)) continue;
      const newestId = toRefresh.get(channelId);
      if (newestId) {
        const result = await this.refreshNewest(cached, newestId);
        refreshed.changed += result.changed;
        refreshed.deleted += result.deleted;
      }
      if (this.stopped) break;
      if (!cached.lastMessageId || compareSnowflakes(cached.lastMessageId, from) <= 0) {
        if (pendingIds.has(channelId)) store.finishGapFill(channelId);
        continue;
      }
      total += await this.gapFillChannel(cached, from);
    }
    if (refreshed.changed + refreshed.deleted > 0) {
      logger.info(
        `archive: while the bot was offline, ${refreshed.changed} archived message(s) changed (reactions, edits) and ${refreshed.deleted} were deleted; updated.`,
      );
    }
    if (total > 0) logger.info(`archive: gap fill archived ${total} message(s) posted while the bot was offline.`);
    return total;
  }

  /**
   * Re-reads the page of messages ending at `newestId` (the channel's newest archived message when the
   * process started) and brings the archived ones up to date with Discord: reactions, edits and
   * deletions made while the bot was offline never arrive as events. One request.
   */
  private async refreshNewest(channel: HistorySource, newestId: string): Promise<{ changed: number; deleted: number }> {
    this.refreshed.add(channel.id);
    // `before` is exclusive: start right after the newest archived id so the page includes it.
    const before = (BigInt(newestId) + 1n).toString();
    const messages = await this.fetchWithRetry(channel, { before, limit: PAGE_SIZE });
    const bounds = messages && pageBounds(messages);
    // Nothing returned (or no access): nothing to compare against, so nothing is concluded.
    if (!messages || !bounds) return { changed: 0, deleted: 0 };
    const store = this.deps.store();
    const inputs = messages.map((m) => toArchiveInput(m)).filter((i) => i !== undefined);
    const changed = store.refreshMessages(inputs);

    // The page holds every message of its span, back to the channel's start when it is short: an
    // archived message inside that span that Discord no longer returns was deleted while offline.
    const reachedStart = messages.length < PAGE_SIZE;
    const present = new Set(messages.map((m) => m.id));
    const gone = store
      .liveMessageIdsSince(channel.id, reachedStart ? 0 : bounds.oldest.createdTimestamp)
      .filter(
        (id) =>
          !present.has(id) &&
          compareSnowflakes(id, newestId) <= 0 &&
          (reachedStart || compareSnowflakes(id, bounds.oldest.id) >= 0),
      );
    const deleted = store.markDeleted(gone, this.deps.now());
    return { changed, deleted };
  }

  private async gapFillChannel(channel: HistorySource, from: string): Promise<number> {
    const store = this.deps.store();
    const label = `#${channel.name ?? channel.id}`;
    store.upsertChannel(channelInfoOf(channel));
    // Saved before the first request, so a run that stops before its first page resumes here too.
    store.startGapFill(channel.id, from, this.deps.now());
    let cursor = from;
    let added = 0;
    let pages = 0;
    while (!this.stopped) {
      const messages = await this.fetchWithRetry(channel, { after: cursor, limit: PAGE_SIZE });
      // A failed request keeps the saved cursor: the next run retries from there.
      if (!messages) return added;
      const bounds = pageBounds(messages);
      if (!bounds) {
        store.finishGapFill(channel.id);
        return added;
      }
      if (compareSnowflakes(bounds.newest.id, cursor) <= 0) {
        logger.warn(`archive: gap fill for ${label} got a page that doesn't move forward; retrying next run.`);
        return added;
      }
      const done = messages.length < PAGE_SIZE;
      const inputs = messages.map((m) => toArchiveInput(m)).filter((i) => i !== undefined);
      added += store.saveGapFillPage(channel.id, inputs, { newestId: bounds.newest.id, done }, this.deps.now());
      if (done) return added;
      cursor = bounds.newest.id;
      pages++;
      if (pages % PROGRESS_EVERY_PAGES === 0) {
        logger.info(`archive: gap fill for ${label}: ${pages} page(s), +${added.toLocaleString('en-US')} so far.`);
      }
    }
    return added;
  }

  /** Imports older history for every configured backfill channel that is not finished yet. */
  async backfill(): Promise<void> {
    const store = this.deps.store();
    const now = this.deps.now();
    for (const channelId of this.deps.backfillChannelIds()) {
      if (this.stopped) break;
      const state = store.getBackfillState(channelId);
      if (state?.done) continue;
      if (state?.errorAt && now - state.errorAt < ERROR_RETRY_MS) continue;
      await this.backfillChannel(channelId);
    }
  }

  private async backfillChannel(channelId: string): Promise<void> {
    const store = this.deps.store();
    let channel: HistorySource | undefined;
    try {
      channel = await this.deps.resolveChannel(channelId);
    } catch (error) {
      channel = undefined;
      logger.warn(`archive: cannot open backfill channel ${channelId}:`, error);
    }
    if (!channel) {
      store.recordBackfillError(channelId, 'channel not found or not readable', this.deps.now());
      logger.warn(`archive: backfill channel ${channelId} is missing or not readable; retrying in an hour.`);
      return;
    }
    if (!isArchivableChannel(channel)) {
      const reason = isIgnoredChannel(channel.id, channel.parentId)
        ? 'is in ARCHIVE_IGNORE_CHANNELS'
        : 'is not a text channel or thread';
      store.recordBackfillError(channelId, `channel ${reason}`, this.deps.now());
      logger.warn(`archive: not backfilling #${channel.name ?? channelId}: it ${reason}.`);
      return;
    }
    store.upsertChannel(channelInfoOf(channel));

    const label = `#${channel.name ?? channelId}`;
    const state = store.getBackfillState(channelId);
    // Resume from the saved cursor; on the first run, from the oldest message already archived (live
    // ingest keeps the archive contiguous from there to now), or from the newest message when none.
    let cursor = state?.cursorId ?? store.oldestMessage(channelId)?.id;
    const newestAt = store.newestMessage(channelId)?.createdAt ?? this.deps.now();
    let pagesThisRun = 0;
    let addedThisRun = 0;
    logger.info(
      `archive: backfilling ${label} ${cursor ? `from message ${cursor} backwards` : 'from the newest message'}${state ? ` (resuming: ${state.pages} page(s) done)` : ''}.`,
    );

    while (!this.stopped) {
      const messages = await this.fetchWithRetry(channel, { before: cursor, limit: PAGE_SIZE });
      if (!messages) {
        // A stop is not a failure: the saved cursor resumes the import next run.
        if (!this.stopped) store.recordBackfillError(channelId, 'fetch failed', this.deps.now());
        return;
      }
      const bounds = pageBounds(messages);
      const done = messages.length < PAGE_SIZE;
      const inputs = messages.map((m) => toArchiveInput(m)).filter((i) => i !== undefined);
      addedThisRun += store.saveBackfillPage(
        channelId,
        inputs,
        {
          cursorId: bounds?.oldest.id ?? null,
          cursorAt: bounds?.oldest.createdTimestamp ?? null,
          fetched: messages.length,
          done,
        },
        this.deps.now(),
      );
      pagesThisRun++;
      if (bounds) cursor = bounds.oldest.id;

      if (done) {
        const total = store.countMessages(channelId);
        logger.info(
          `archive: backfill of ${label} complete — ${total.toLocaleString('en-US')} message(s) archived for it (${addedThisRun.toLocaleString('en-US')} new this run). ${this.storageLine()}`,
        );
        store.optimize();
        return;
      }
      if (pagesThisRun % PROGRESS_EVERY_PAGES === 0) {
        this.logProgress(
          label,
          channel,
          channelId,
          bounds?.oldest.createdTimestamp ?? newestAt,
          newestAt,
          addedThisRun,
        );
      }
    }
  }

  /**
   * Progress with a storage estimate: how far back the channel's import has reached as a share of the
   * channel's lifetime, the archive's current size, and a naive (uniform-activity) projection of the
   * size once the channel is complete.
   */
  private logProgress(
    label: string,
    channel: HistorySource,
    channelId: string,
    reachedAt: number,
    newestAt: number,
    addedThisRun: number,
  ): void {
    const store = this.deps.store();
    const total = store.countMessages();
    const channelCount = store.countMessages(channelId);
    const size = store.sizeBytes();
    const perMessage = total > 0 ? size / total : 0;
    let estimate = '';
    const createdAt = channel.createdTimestamp ?? undefined;
    if (createdAt && newestAt > createdAt) {
      const covered = Math.min(1, Math.max(0.001, (newestAt - reachedAt) / (newestAt - createdAt)));
      const projectedChannel = channelCount / covered;
      const projectedSize = size + (projectedChannel - channelCount) * perMessage;
      estimate = ` ~${Math.round(covered * 100)}% of the channel's lifetime; projected ~${Math.round(projectedChannel).toLocaleString('en-US')} messages / ${formatMb(projectedSize)} when done.`;
    }
    logger.info(
      `archive: backfilling ${label}: back to ${formatDate(reachedAt)}, +${addedThisRun.toLocaleString('en-US')} this run.${estimate} ${this.storageLine()}`,
    );
  }

  private storageLine(): string {
    const store = this.deps.store();
    const total = store.countMessages();
    const size = store.sizeBytes();
    const perMessage = total > 0 ? Math.round(size / total) : 0;
    return `Archive: ${total.toLocaleString('en-US')} messages, ${formatMb(size)} (~${perMessage} B/message).`;
  }

  /**
   * One history request, politely spaced, with retries for transient failures (network, 5xx). Missing
   * access / unknown channel is not retried. Undefined when the request ultimately failed.
   */
  private async fetchWithRetry(
    channel: HistorySource,
    options: { before?: string; after?: string; limit: number },
  ): Promise<Message[] | undefined> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (this.stopped) return undefined;
      const delay = this.deps.delayMs();
      const wait = attempt === 0 ? delay : Math.min(60_000, Math.max(2000, delay) * 2 ** attempt);
      if (this.requestsMade > 0 || attempt > 0) await this.deps.sleep(wait);
      if (this.stopped) return undefined;
      this.requestsMade++;
      try {
        return await channel.fetchPage(options);
      } catch (error) {
        if (isPermanentError(error)) {
          logger.warn(`archive: no access to history of #${channel.name ?? channel.id}: ${describeError(error)}`);
          return undefined;
        }
        logger.warn(
          `archive: history request for #${channel.name ?? channel.id} failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${describeError(error)}`,
        );
      }
    }
    return undefined;
  }

  /**
   * Periodic upkeep: resolve relay kinds and pull in fresh voice transcripts, then resume an unfinished
   * backfill if nothing is running (a channel that errored is retried once ERROR_RETRY_MS has passed).
   */
  maintenance(): void {
    try {
      const store = this.deps.store();
      reconcileRelays(store);
      refreshTranscripts(store);
    } catch (error) {
      logger.warn('archive: maintenance failed:', error);
    }
    if (!this.running && config.archive.backfillEnabled && this.hasPendingBackfill()) {
      void this.run().catch((error) => logger.warn('archive: resumed backfill failed:', error));
    }
  }

  private hasPendingBackfill(): boolean {
    const store = this.deps.store();
    const now = this.deps.now();
    return this.deps.backfillChannelIds().some((id) => {
      const state = store.getBackfillState(id);
      if (!state) return true;
      if (state.done) return false;
      return !state.errorAt || now - state.errorAt >= ERROR_RETRY_MS;
    });
  }
}

/** A HistorySource over a discord.js channel, or undefined when it is not a readable text channel. */
export function historySourceOf(channel: unknown): HistorySource | undefined {
  if (!channel || typeof channel !== 'object') return undefined;
  const candidate = channel as {
    id: string;
    type: number;
    name?: string | null;
    parentId?: string | null;
    guildId?: string | null;
    createdTimestamp?: number | null;
    lastMessageId?: string | null;
    isTextBased?: () => boolean;
    messages?: { fetch: (options: object) => Promise<{ values(): Iterable<Message> }> };
  };
  if (typeof candidate.isTextBased !== 'function' || !candidate.isTextBased() || !candidate.messages) return undefined;
  const messages = candidate.messages;
  return {
    id: candidate.id,
    type: candidate.type,
    name: candidate.name,
    parentId: candidate.parentId,
    guildId: candidate.guildId,
    createdTimestamp: candidate.createdTimestamp,
    lastMessageId: candidate.lastMessageId,
    fetchPage: async (options) => [...(await messages.fetch({ ...options, cache: false })).values()],
  };
}

export function discordSyncDeps(client: Client): ArchiveSyncDeps {
  return {
    store: getArchiveStore,
    resolveChannel: async (id) => historySourceOf(client.channels.cache.get(id) ?? (await client.channels.fetch(id))),
    peekChannel: (id) => historySourceOf(client.channels.cache.get(id)),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    delayMs: () => config.archive.backfillDelayMs,
    backfillChannelIds: () => config.archive.backfillChannels,
  };
}

let activeSync: ArchiveSync | undefined;

/** The running sync (set by the ClientReady handler), for status checks elsewhere (Wrapped). */
export function getActiveArchiveSync(): ArchiveSync | undefined {
  return activeSync;
}

export function setActiveArchiveSync(sync: ArchiveSync | undefined): void {
  activeSync = sync;
}
