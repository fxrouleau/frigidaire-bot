import type { Channel } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMemoryStoreForTesting } from '../ai/memory';
import { MemoryStore } from '../ai/memory/memoryStore';
import { createFakeChannel, createFakeClient } from '../test-support/fakeDiscord';
import { config } from '../config';
import deployAnnounceEvent, { formatAnnouncement, shouldAnnounce } from './deployAnnounce';

const ENV_KEYS = ['REPORT_CHANNEL_ID', 'GIT_SHA', 'DEPLOY_ANNOUNCE_ENABLED'] as const;
const CHANNEL_ID = 'report-1';

let savedEnv: Record<string, string | undefined>;
let store: MemoryStore;

const execute = deployAnnounceEvent.execute;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  store = new MemoryStore(':memory:');
  setMemoryStoreForTesting(store);
  // Hermetic: no channel variables from the developer's shell leak into the announcement.
  for (const { name } of config.logging.channelVariables) {
    if (!(ENV_KEYS as readonly string[]).includes(name)) vi.stubEnv(name, '');
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setMemoryStoreForTesting(undefined);
  vi.unstubAllEnvs();
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
  it('is a once-only ClientReady handler', () => {
    expect(deployAnnounceEvent.name).toBe('clientReady');
    expect(deployAnnounceEvent.once).toBe(true);
  });

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

  it.each(['false', '0', 'no'])('is a no-op when DEPLOY_ANNOUNCE_ENABLED=%s even with a fresh sha', async (flag) => {
    const { fakeChannel, fakeClient } = setup();
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    process.env.GIT_SHA = 'abcdef1234567890';
    process.env.DEPLOY_ANNOUNCE_ENABLED = flag;

    await execute(fakeClient.client);

    expect(fakeClient.recorders.channelsFetch.calls).toHaveLength(0);
    expect(fakeChannel.recorders.send.calls).toHaveLength(0);
    // The switch must not silently consume the sha — a later enable should still announce.
    expect(store.getState('deploy:last_announced_sha')).toBeUndefined();
  });
});

describe('deploy announcement channel block', () => {
  const MOD_LOGS = '700000000000000001';
  const GONE = '700000000000000099';

  it('lists the channel configuration as #names under the headline, in a code block', async () => {
    const fakeChannel = createFakeChannel({ id: CHANNEL_ID });
    const modLogs = { id: MOD_LOGS, name: 'mod-logs' } as unknown as Channel;
    const fakeClient = createFakeClient({ channelsById: { [CHANNEL_ID]: fakeChannel.channel, [MOD_LOGS]: modLogs } });
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    process.env.GIT_SHA = 'abcdef1234567890';
    vi.stubEnv('LEARNER_IGNORE_CHANNELS', `${MOD_LOGS},${GONE}`);

    await execute(fakeClient.client);

    const sent = String(fakeChannel.recorders.send.calls[0][0]);
    const [headline, ...rest] = sent.split('\n');
    expect(headline).toMatch(/^🚀 Deployed `abcdef1` · .* ET$/);
    expect(rest).toEqual([
      '```',
      `LEARNER_IGNORE_CHANNELS: #mod-logs (1 unknown: ${GONE})`,
      // The test's report channel id is not a snowflake, which is exactly what the block should flag.
      `REPORT_CHANNEL_ID: (1 not a channel id: ${CHANNEL_ID})`,
      '```',
    ]);
  });

  it('is just the headline when no channel variables resolve to anything', () => {
    expect(formatAnnouncement('🚀 Deployed `abc`', [])).toBe('🚀 Deployed `abc`');
    expect(formatAnnouncement('🚀 Deployed `abc`', ['A_CHANNEL_ID: #a'])).toBe(
      '🚀 Deployed `abc`\n```\nA_CHANNEL_ID: #a\n```',
    );
  });
});
