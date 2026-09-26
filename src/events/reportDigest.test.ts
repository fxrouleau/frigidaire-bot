import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setMemoryStoreForTesting } from '../ai/memory';
import { MemoryStore } from '../ai/memory/memoryStore';
import { recordUsage } from '../ai/usage';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { createFakeChannel, createFakeClient, sentContent } from '../test-support/fakeDiscord';
import reportDigestEvent, { runDigestCheck } from './reportDigest';

const ENV_KEYS = [
  'REPORT_CHANNEL_ID',
  'DIGEST_ENABLED',
  'DIGEST_PERIOD_MS',
  'DIGEST_CHECK_INTERVAL_MS',
  'DEBUG_CAPTURE_DIR',
  'USAGE_LEDGER_ENABLED',
] as const;
const CHANNEL_ID = 'report-digest-1';
const WATERMARK_KEY = 'digest:last_run_at';

let savedEnv: Record<string, string | undefined>;
let store: MemoryStore;
let tmpDir: string;
let fakeChannel: ReturnType<typeof createFakeChannel>;
let fakeClient: ReturnType<typeof createFakeClient>;

const execute = reportDigestEvent.execute;

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
  setBotDbForTesting(new BotDb(':memory:'));

  fakeChannel = createFakeChannel({ id: CHANNEL_ID });
  fakeClient = createFakeClient({ channelsById: { [CHANNEL_ID]: fakeChannel.channel } });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setMemoryStoreForTesting(undefined);
  setBotDbForTesting(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runDigestCheck watermark gating', () => {
  it('posts and advances the watermark on the first run (no prior watermark)', async () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    await store.save({ category: 'capability_gap', subject: 'bot', content: 'Cannot read receipts' });

    await runDigestCheck(fakeClient.client);

    expect(fakeChannel.recorders.send.calls).toHaveLength(1);
    expect(sentContent(fakeChannel.recorders.send.calls[0][0])).toContain('Cannot read receipts');
    expect(store.getState(WATERMARK_KEY)).toBeDefined();
  });

  it('labels the digest with the period that just ended (last run → now), not the coming week', async () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    store.setState(WATERMARK_KEY, eightDaysAgo.toISOString());
    await store.save({ category: 'capability_gap', subject: 'bot', content: 'Cannot read receipts' });

    await runDigestCheck(fakeClient.client);

    const sent = sentContent(fakeChannel.recorders.send.calls[0][0]);
    const today = new Date().toISOString().slice(0, 10);
    expect(sent).toContain(`${eightDaysAgo.toISOString().slice(0, 10)} → ${today}`);
  });

  it('after a long gap (bot down for weeks) says "since the last digest", not "this week"', async () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    store.setState(WATERMARK_KEY, new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString());
    await store.save({ category: 'capability_gap', subject: 'bot', content: 'Cannot read receipts' });

    await runDigestCheck(fakeClient.client);

    const sent = sentContent(fakeChannel.recorders.send.calls[0][0]);
    expect(sent).toContain('🩺 Self-diagnosis digest (5 weeks)');
    expect(sent).toContain('(1 new since the last digest)');
    expect(sent).not.toContain('this week');
  });

  it('keeps the watermark when the post fails, so the next check posts the same period', async () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    store.setState(WATERMARK_KEY, eightDaysAgo);
    await store.save({ category: 'capability_gap', subject: 'bot', content: 'Cannot read receipts' });
    const failing = createFakeChannel({ id: CHANNEL_ID, sendError: new Error('503 Service Unavailable') });

    await runDigestCheck(createFakeClient({ channelsById: { [CHANNEL_ID]: failing.channel } }).client);

    expect(failing.recorders.send.calls).toHaveLength(1);
    expect(store.getState(WATERMARK_KEY)).toBe(eightDaysAgo);

    await runDigestCheck(fakeClient.client);

    expect(fakeChannel.recorders.send.calls).toHaveLength(1);
    const sent = sentContent(fakeChannel.recorders.send.calls[0][0]);
    expect(sent).toContain('Cannot read receipts');
    expect(sent).toContain(eightDaysAgo.slice(0, 10));
    expect(store.getState(WATERMARK_KEY)).not.toBe(eightDaysAgo);
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

    const sent = sentContent(fakeChannel.recorders.send.calls[0][0]);
    expect(sent).toContain('bot gap visible');
    expect(sent).not.toContain('user gap hidden');
  });
});

describe('runDigestCheck privacy', () => {
  it('never leaks an error capture conversation payload into the rendered digest', async () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    // A signal forces the full (non-quiet) digest, so the captures section actually renders.
    await store.save({ category: 'capability_gap', subject: 'bot', content: 'some gap' });

    // A realistic capture file: privacy-safe metadata (timestamp + a bare network-error message, which
    // the digest IS allowed to surface as a label) PLUS the private chat payload it must never read.
    // The sentinels are distinctive lowercase tokens so any leak survives the digest's label derivation
    // (which lowercases and keeps the leading word) and is caught here.
    const SENTINEL = 'mysecretpayload';
    const capture = {
      timestamp: new Date().toISOString(),
      channelId: 'c1',
      model: 'test-model',
      error: { name: 'Error', message: 'read ECONNRESET' },
      conversationEntries: [
        { kind: 'message', role: 'user', content: [{ type: 'text', text: `${SENTINEL} my credit card is 1234` }] },
        { kind: 'message', role: 'assistant', content: [{ type: 'text', text: `noted about ${SENTINEL}` }] },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, 'error-1-aaaa.json'), JSON.stringify(capture), 'utf8');

    await runDigestCheck(fakeClient.client);

    const sent = sentContent(fakeChannel.recorders.send.calls[0][0]);
    // The capture is counted and its privacy-safe network-error code surfaces as a label...
    expect(sent).toContain('AI errors captured (data/debug) — 1');
    expect(sent).toContain('ECONNRESET');
    // ...but nothing from the private conversation payload ever appears.
    expect(sent).not.toContain(SENTINEL);
    expect(sent).not.toContain('credit card');
  });
});

describe('reportDigest execute master switch', () => {
  it('is a once-only ClientReady handler', () => {
    expect(reportDigestEvent.name).toBe('clientReady');
    expect(reportDigestEvent.once).toBe(true);
  });

  it('is a no-op (no channel fetch) when REPORT_CHANNEL_ID is unset', () => {
    execute(fakeClient.client);
    expect(fakeClient.recorders.channelsFetch.calls).toHaveLength(0);
  });

  it.each(['false', '0'])('is a no-op when DIGEST_ENABLED=%s', (flag) => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    process.env.DIGEST_ENABLED = flag;
    execute(fakeClient.client);
    expect(fakeClient.recorders.channelsFetch.calls).toHaveLength(0);
  });
});

describe('runDigestCheck spend', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("reports the period's complete Eastern days of spend; today is left for the next digest", async () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    store.setState(WATERMARK_KEY, new Date(Date.now() - 8 * DAY).toISOString());
    recordUsage({ feature: 'chat', model: 'deepseek/deepseek-v3.2', cost: 0.25, at: Date.now() - 2 * DAY });
    recordUsage({ feature: 'learner', model: 'qwen/qwen3-vl', cost: 0.1, at: Date.now() - 3 * DAY });
    recordUsage({ feature: 'image', model: 'gemini-image', cost: 7, at: Date.now() }); // today
    recordUsage({ feature: 'image', model: 'gemini-image', cost: 9, at: Date.now() - 30 * DAY }); // before the period

    await runDigestCheck(fakeClient.client);

    const sent = fakeChannel.recorders.send.calls.map((c) => sentContent(c[0])).join('\n');
    expect(sent).toContain('— $0.35 over 2 calls');
    expect(sent).toContain('by feature: chat $0.25 (1 call) · learner $0.10 (1 call)');
    expect(sent).not.toContain('gemini-image');
  });

  it('omits the Spend section when the ledger is disabled', async () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    process.env.USAGE_LEDGER_ENABLED = 'false';

    await runDigestCheck(fakeClient.client);

    expect(sentContent(fakeChannel.recorders.send.calls[0][0])).not.toContain('Spend');
  });
});
