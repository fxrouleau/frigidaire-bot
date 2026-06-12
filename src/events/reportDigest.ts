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
import { SELF_DIAGNOSIS_CATEGORIES } from '../ai/memory/memoryStore';
import { getReportChannelId, sendToReportChannel } from '../ai/reportChannel';
import { getMemoryStore } from '../ai/tools';
import { logger } from '../logger';

const WATERMARK_KEY = 'digest:last_run_at';
const DEFAULT_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
// Display caps at 10/category; this only bounds the count query so active totals stay accurate.
const CATEGORY_QUERY_CAP = 500;

export const name = Events.ClientReady;
export const once = true;

export function execute(client: Client): void {
  if (!getReportChannelId() || process.env.DIGEST_ENABLED === 'false') return;

  void runDigestCheck(client);
  const interval = envPositiveMs('DIGEST_CHECK_INTERVAL_MS', DEFAULT_CHECK_INTERVAL_MS);
  setInterval(() => void runDigestCheck(client), interval).unref();
}

/** Posts the digest if a full period has elapsed since the last run, then advances the watermark. */
export async function runDigestCheck(client: Client): Promise<void> {
  try {
    const store = getMemoryStore();
    const now = new Date();
    const lastRunIso = store.getState(WATERMARK_KEY);
    const watermark = lastRunIso ? new Date(lastRunIso) : null;
    const periodMs = envPositiveMs('DIGEST_PERIOD_MS', DEFAULT_PERIOD_MS);

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

    const digest = buildDigest({
      periodStart: now,
      periodEnd: new Date(now.getTime() + periodMs),
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
  const dir = process.env.DEBUG_CAPTURE_DIR || './data/debug';
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

function envPositiveMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
