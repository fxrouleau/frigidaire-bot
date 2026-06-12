import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../ai/memory/memoryStore';
import { setMemoryStoreForTesting } from '../ai/tools';
import { createFakeChannel, createFakeClient } from '../test-support/fakeDiscord';
import { execute, shouldAnnounce } from './deployAnnounce';

const ENV_KEYS = ['REPORT_CHANNEL_ID', 'GIT_SHA', 'DEPLOY_ANNOUNCE_ENABLED'] as const;
const CHANNEL_ID = 'report-1';

let savedEnv: Record<string, string | undefined>;
let store: MemoryStore;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  store = new MemoryStore(':memory:');
  setMemoryStoreForTesting(store);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setMemoryStoreForTesting(undefined);
});

function setup() {
  const fakeChannel = createFakeChannel({ id: CHANNEL_ID });
  const fakeClient = createFakeClient({ channelsById: { [CHANNEL_ID]: fakeChannel.channel } });
  return { fakeChannel, fakeClient };
}

describe('shouldAnnounce', () => {
  it('is false when the current sha is unset', () => {
    expect(shouldAnnounce(undefined, 'abc1234')).toBe(false);
  });

  it('is false when current equals stored', () => {
    expect(shouldAnnounce('abc1234', 'abc1234')).toBe(false);
  });

  it('is true when current differs from stored', () => {
    expect(shouldAnnounce('def5678', 'abc1234')).toBe(true);
  });

  it('is true on the first deploy (no stored sha)', () => {
    expect(shouldAnnounce('def5678', undefined)).toBe(true);
  });
});

describe('deployAnnounce execute', () => {
  it('announces once with the 7-char sha and persists the full sha', async () => {
    const { fakeChannel, fakeClient } = setup();
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    process.env.GIT_SHA = 'abcdef1234567890';

    await execute(fakeClient.client);

    expect(fakeChannel.recorders.send.calls).toHaveLength(1);
    expect(String(fakeChannel.recorders.send.calls[0][0])).toContain('🚀 Deployed `abcdef1`');
    expect(store.getState('deploy:last_announced_sha')).toBe('abcdef1234567890');

    // A second boot on the same sha stays silent.
    await execute(fakeClient.client);
    expect(fakeChannel.recorders.send.calls).toHaveLength(1);
  });

  it('does not announce when the stored sha already matches', async () => {
    const { fakeChannel, fakeClient } = setup();
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    process.env.GIT_SHA = 'sha-equal';
    store.setState('deploy:last_announced_sha', 'sha-equal');

    await execute(fakeClient.client);
    expect(fakeChannel.recorders.send.calls).toHaveLength(0);
  });

  it('is a no-op (no channel fetch) when REPORT_CHANNEL_ID is unset', async () => {
    const { fakeClient } = setup();
    process.env.GIT_SHA = 'abcdef1234567890'; // sha present, but channel master switch is off

    await execute(fakeClient.client);
    expect(fakeClient.recorders.channelsFetch.calls).toHaveLength(0);
  });

  it('does nothing when GIT_SHA is empty', async () => {
    const { fakeClient } = setup();
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;

    await execute(fakeClient.client);
    expect(fakeClient.recorders.channelsFetch.calls).toHaveLength(0);
  });

  it('is a no-op when DEPLOY_ANNOUNCE_ENABLED=false even with a fresh sha', async () => {
    const { fakeChannel, fakeClient } = setup();
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    process.env.GIT_SHA = 'abcdef1234567890';
    process.env.DEPLOY_ANNOUNCE_ENABLED = 'false';

    await execute(fakeClient.client);

    expect(fakeClient.recorders.channelsFetch.calls).toHaveLength(0);
    expect(fakeChannel.recorders.send.calls).toHaveLength(0);
    // The switch must not silently consume the sha — a later enable should still announce.
    expect(store.getState('deploy:last_announced_sha')).toBeUndefined();
  });
});
