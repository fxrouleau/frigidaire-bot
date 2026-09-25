import type { Channel } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChannelNameLookup,
  describeChannelEnvironment,
  discordChannelLookup,
  formatChannelVariable,
  parseChannelVariables,
} from './channelEnv';
import { config } from './config';
import channelEnvLogEvent from './events/channelEnvLog';
import { logger } from './logger';
import { createFakeClient } from './test-support/fakeDiscord';

// Invented snowflakes (the repo is public).
const MOD_LOGS = '700000000000000001';
const BOT_TESTING = '700000000000000002';
const MAIN = '700000000000000003';
const GONE = '700000000000000099';

const NAMES: Record<string, string> = { [MOD_LOGS]: 'mod-logs', [BOT_TESTING]: 'bot-testing', [MAIN]: 'bagel-bar' };
const lookup: ChannelNameLookup = async (id) => NAMES[id];

function namedChannel(id: string, name: string): Channel {
  return { id, name } as unknown as Channel;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('config.logging.channelVariables', () => {
  it('finds channel variables by naming convention, sorted, skipping blank ones', () => {
    vi.stubEnv('REPORT_CHANNEL_ID', MOD_LOGS);
    vi.stubEnv('LEARNER_IGNORE_CHANNELS', `${MOD_LOGS},${BOT_TESTING}`);
    vi.stubEnv('SOME_FUTURE_CHANNEL_IDS', MAIN);
    vi.stubEnv('CHANNEL_NOTES', '{}');
    vi.stubEnv('ARCHIVE_CHANNEL_ID', '  ');
    vi.stubEnv('CHANNEL_ID_PREFIX', 'nope'); // does not END with the suffix
    vi.stubEnv('CLIENT_SECRET', 'not-a-channel');

    const names = config.logging.channelVariables.map((v) => v.name);
    for (const expected of ['CHANNEL_NOTES', 'LEARNER_IGNORE_CHANNELS', 'REPORT_CHANNEL_ID', 'SOME_FUTURE_CHANNEL_IDS']) {
      expect(names).toContain(expected);
    }
    expect(names).not.toContain('ARCHIVE_CHANNEL_ID');
    expect(names).not.toContain('CHANNEL_ID_PREFIX');
    expect(names).not.toContain('CLIENT_SECRET');
    expect(names).toEqual([...names].sort());
  });
});

describe('parseChannelVariables', () => {
  it('splits lists on commas, semicolons and whitespace, dedupes ids and keeps what is not an id', () => {
    const [parsed] = parseChannelVariables([
      { name: 'LEARNER_IGNORE_CHANNELS', value: `${MOD_LOGS}, ${BOT_TESTING};${MOD_LOGS} general` },
    ]);
    expect(parsed).toEqual({ name: 'LEARNER_IGNORE_CHANNELS', ids: [MOD_LOGS, BOT_TESTING], invalid: ['general'] });
  });

  it("reads CHANNEL_NOTES' JSON keys, and flags a value that is not a JSON object", () => {
    const [notes, broken, array] = parseChannelVariables([
      { name: 'CHANNEL_NOTES', value: JSON.stringify({ [MAIN]: 'where everything happens', clips: 'league' }) },
      { name: 'CHANNEL_NOTES', value: '{not json' },
      { name: 'CHANNEL_NOTES', value: '[1, 2]' },
    ]);
    expect(notes).toEqual({ name: 'CHANNEL_NOTES', ids: [MAIN], invalid: ['clips'] });
    expect(broken.problem).toBe('not valid JSON');
    expect(array.problem).toMatch(/not a JSON object/);
  });

  it('truncates a long non-id value', () => {
    const [parsed] = parseChannelVariables([{ name: 'X_CHANNEL_ID', value: 'x'.repeat(100) }]);
    expect(parsed.invalid[0]).toBe(`${'x'.repeat(40)}…`);
  });
});

describe('formatChannelVariable', () => {
  const names = new Map<string, string | undefined>([
    [MOD_LOGS, 'mod-logs'],
    [BOT_TESTING, 'bot-testing'],
    [GONE, undefined],
  ]);

  it('lists #names, then unknown ids, then entries that are not ids', () => {
    expect(
      formatChannelVariable(
        { name: 'LEARNER_IGNORE_CHANNELS', ids: [MOD_LOGS, BOT_TESTING, GONE], invalid: ['general'] },
        names,
      ),
    ).toBe(`LEARNER_IGNORE_CHANNELS: #mod-logs, #bot-testing (1 unknown: ${GONE}) (1 not a channel id: general)`);
  });

  it('handles a variable with nothing resolvable, nothing at all, or an unreadable value', () => {
    expect(formatChannelVariable({ name: 'REPORT_CHANNEL_ID', ids: [GONE], invalid: [] }, names)).toBe(
      `REPORT_CHANNEL_ID: (1 unknown: ${GONE})`,
    );
    expect(formatChannelVariable({ name: 'CHANNEL_NOTES', ids: [], invalid: [] }, names)).toBe(
      'CHANNEL_NOTES: (no channel ids)',
    );
    expect(formatChannelVariable({ name: 'CHANNEL_NOTES', ids: [], invalid: [], problem: 'not valid JSON' }, names)).toBe(
      'CHANNEL_NOTES: (not valid JSON)',
    );
  });
});

describe('describeChannelEnvironment', () => {
  it('resolves each distinct id once and returns one line per variable', async () => {
    const seen: string[] = [];
    const counting: ChannelNameLookup = async (id) => {
      seen.push(id);
      return NAMES[id];
    };

    const lines = await describeChannelEnvironment(counting, [
      { name: 'LEARNER_IGNORE_CHANNELS', value: `${MOD_LOGS},${BOT_TESTING},${GONE}` },
      { name: 'REPORT_CHANNEL_ID', value: BOT_TESTING },
    ]);

    expect(lines).toEqual([
      `LEARNER_IGNORE_CHANNELS: #mod-logs, #bot-testing (1 unknown: ${GONE})`,
      'REPORT_CHANNEL_ID: #bot-testing',
    ]);
    expect(seen.sort()).toEqual([MOD_LOGS, BOT_TESTING, GONE].sort());
  });

  it('is empty when no channel variables are set', async () => {
    expect(await describeChannelEnvironment(lookup, [])).toEqual([]);
  });
});

describe('discordChannelLookup', () => {
  it('returns the channel name, and undefined for channels the bot cannot fetch or that have no name', async () => {
    const { client } = createFakeClient({
      channelsById: {
        [MOD_LOGS]: namedChannel(MOD_LOGS, 'mod-logs'),
        [MAIN]: { id: MAIN } as unknown as Channel, // e.g. a DM channel
      },
    });
    const resolve = discordChannelLookup(client);

    expect(await resolve(MOD_LOGS)).toBe('mod-logs');
    expect(await resolve(MAIN)).toBeUndefined();
    expect(await resolve(GONE)).toBeUndefined(); // fetch throws (Unknown Channel)
  });
});

describe('channelEnvLog event', () => {
  it('is a once-only ClientReady handler that logs one line per channel variable', async () => {
    expect(channelEnvLogEvent.name).toBe('clientReady');
    expect(channelEnvLogEvent.once).toBe(true);

    for (const { name } of config.logging.channelVariables) vi.stubEnv(name, '');
    vi.stubEnv('LEARNER_IGNORE_CHANNELS', `${MOD_LOGS},${GONE}`);
    vi.stubEnv('MAIN_CHANNEL_ID', MAIN);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const { client } = createFakeClient({
      channelsById: { [MOD_LOGS]: namedChannel(MOD_LOGS, 'mod-logs'), [MAIN]: namedChannel(MAIN, 'bagel-bar') },
    });

    await channelEnvLogEvent.execute(client);

    expect(info.mock.calls.map((call) => call[0])).toEqual([
      `Channel config · LEARNER_IGNORE_CHANNELS: #mod-logs (1 unknown: ${GONE})`,
      'Channel config · MAIN_CHANNEL_ID: #bagel-bar',
    ]);
  });
});
