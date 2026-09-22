// Periodically posts a weekly self-diagnosis digest to the report channel. Off unless REPORT_CHANNEL_ID
// is set; DIGEST_ENABLED=false also disables it. The watermark (digest:last_run_at) gates posting to
// once per DIGEST_PERIOD_MS regardless of how often the check fires.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Client, Events } from 'discord.js';
import {
  type CaptureMeta,
  type DigestFailure,
  type DigestSignal,
  FAILURE_CATEGORIES,
  SIGNAL_CATEGORIES,
  buildDigest,
  summarizeErrorCaptures,
} from '../ai/digest';
import { getMemoryStore } from '../ai/memory';
import { SELF_DIAGNOSIS_CATEGORIES } from '../ai/memory/memoryStore';
import { getReportChannelId, sendToReportChannel } from '../ai/reportChannel';
import { config } from '../config';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

const WATERMARK_KEY = 'digest:last_run_at';
// Display caps at 10/category; this only bounds the count query so active totals stay accurate.
const CATEGORY_QUERY_CAP = 500;

export default defineEvent(Events.ClientReady, {
  once: true,
  execute(client) {
    if (!getReportChannelId() || !config.report.digestEnabled) return;

    void runDigestCheck(client);
    setInterval(() => void runDigestCheck(client), config.report.digestCheckIntervalMs).unref();
  },
});

/** Posts the digest if a full period has elapsed since the last run, then advances the watermark. */
export async function runDigestCheck(client: Client): Promise<void> {
  try {
    const store = getMemoryStore();
    const now = new Date();
    const lastRunIso = store.getState(WATERMARK_KEY);
    const watermark = lastRunIso ? new Date(lastRunIso) : null;
    const periodMs = config.report.digestPeriodMs;

    if (watermark && now.getTime() - watermark.getTime() < periodMs) return;

    const signalSet = new Set<string>(SIGNAL_CATEGORIES);
    const failureSet = new Set<string>(FAILURE_CATEGORIES);
    const signals: DigestSignal[] = [];
    const failures: DigestFailure[] = [];
    for (const category of SELF_DIAGNOSIS_CATEGORIES) {
      // Mirror query_self_diagnosis's subject filter: only the bot's / server's own signals.
      const rows = store
        .getByCategory(category, CATEGORY_QUERY_CAP)
        .filter((r) => r.subject === 'bot' || r.subject === 'server');
      if (signalSet.has(category)) {
        for (const r of rows) signals.push({ category, content: r.content, updated_at: r.updated_at });
      } else if (failureSet.has(category)) {
        for (const r of rows) failures.push({ category, updated_at: r.updated_at });
      }
    }

    const captures = summarizeErrorCaptures(readCaptureMetadata(), watermark ?? new Date(0));

    // The digest reports on the period that just ENDED: from the last run (or one period back on the
    // very first run) up to now.
    const digest = buildDigest({
      periodStart: watermark ?? new Date(now.getTime() - periodMs),
      periodEnd: now,
      watermark,
      signals,
      failures,
      captures,
    });

    await sendToReportChannel(client, digest);
    store.setState(WATERMARK_KEY, now.toISOString());
  } catch (error) {
    logger.warn('Digest check failed:', error);
  }
}

/** Reads ONLY privacy-safe metadata (timestamp + error status/message) from each capture file. */
function readCaptureMetadata(): CaptureMeta[] {
  const dir = config.debugCapture.dir;
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((n) => n.startsWith('error-') && n.endsWith('.json'));
  } catch {
    return []; // dir absent ⇒ no captures
  }

  const metas: CaptureMeta[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const parsed = JSON.parse(raw) as { timestamp?: string; error?: { message?: string; status?: number } };
      // Deliberately never read conversationEntries — captures hold full private chats.
      metas.push({
        timestamp: parsed.timestamp ?? '',
        status: typeof parsed.error?.status === 'number' ? parsed.error.status : undefined,
        message: parsed.error?.message ?? '',
      });
    } catch {
      // Unreadable/corrupt capture file — skip it.
    }
  }
  return metas;
}
