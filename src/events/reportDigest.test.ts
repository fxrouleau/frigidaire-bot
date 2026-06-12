import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../ai/memory/memoryStore';
import { setMemoryStoreForTesting } from '../ai/tools';
import { createFakeChannel, createFakeClient } from '../test-support/fakeDiscord';
import { execute, runDigestCheck } from './reportDigest';

const ENV_KEYS = [
  'REPORT_CHANNEL_ID',
  'DIGEST_ENABLED',
  'DIGEST_PERIOD_MS',
  'DIGEST_CHECK_INTERVAL_MS',
  'DEBUG_CAPTURE_DIR',
] as const;
const CHANNEL_ID = 'report-digest-1';
const WATERMARK_KEY = 'digest:last_run_at';

let savedEnv: Record<string, string | undefined>;
let store: MemoryStore;
let tmpDir: string;
let fakeChannel: ReturnType<typeof createFakeChannel>;
let fakeClient: ReturnType<typeof createFakeClient>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // Point capture reads at an empty temp dir so the suite never touches a real ./data/debug.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-test-'));
  process.env.DEBUG_CAPTURE_DIR = tmpDir;

  store = new MemoryStore(':memory:');
  setMemoryStoreForTesting(store);

  fakeChannel = createFakeChannel({ id: CHANNEL_ID });
  fakeClient = createFakeClient({ channelsById: { [CHANNEL_ID]: fakeChannel.channel } });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setMemoryStoreForTesting(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runDigestCheck watermark gating', () => {
  it('posts and advances the watermark on the first run (no prior watermark)', async () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    await store.save({ category: 'capability_gap', subject: 'bot', content: 'Cannot read receipts' });

    await runDigestCheck(fakeClient.client);

    expect(fakeChannel.recorders.send.calls).toHaveLength(1);
    expect(String(fakeChannel.recorders.send.calls[0][0])).toContain('Cannot read receipts');
    expect(store.getState(WATERMARK_KEY)).toBeDefined();
  });

  it('does not post when the last run is within the period', async () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    store.setState(WATERMARK_KEY, new Date().toISOString());

    await runDigestCheck(fakeClient.client);

    expect(fakeChannel.recorders.send.calls).toHaveLength(0);
  });

  it('posts again and updates the watermark once a full period has elapsed', async () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    store.setState(WATERMARK_KEY, eightDaysAgo);

    await runDigestCheck(fakeClient.client);

    expect(fakeChannel.recorders.send.calls).toHaveLength(1);
    expect(store.getState(WATERMARK_KEY)).not.toBe(eightDaysAgo);
  });

  it('surfaces only bot/server self-diagnosis subjects (mirrors query_self_diagnosis)', async () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    await store.save({ category: 'capability_gap', subject: 'bot', content: 'bot gap visible' });
    await store.save({ category: 'capability_gap', subject: 'Alice', content: 'user gap hidden' });

    await runDigestCheck(fakeClient.client);

    const sent = String(fakeChannel.recorders.send.calls[0][0]);
    expect(sent).toContain('bot gap visible');
    expect(sent).not.toContain('user gap hidden');
  });
});

describe('reportDigest execute master switch', () => {
  it('is a no-op (no channel fetch) when REPORT_CHANNEL_ID is unset', () => {
    execute(fakeClient.client);
    expect(fakeClient.recorders.channelsFetch.calls).toHaveLength(0);
  });

  it('is a no-op when DIGEST_ENABLED=false', () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    process.env.DIGEST_ENABLED = 'false';
    execute(fakeClient.client);
    expect(fakeClient.recorders.channelsFetch.calls).toHaveLength(0);
  });
});
