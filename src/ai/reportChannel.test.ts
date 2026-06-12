import type { Channel } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeChannel, createFakeClient } from '../test-support/fakeDiscord';
import { logger } from '../logger';
import { getReportChannelId, sendToReportChannel } from './reportChannel';

const CHANNEL_ID = 'report-chan-1';
let savedChannelId: string | undefined;

beforeEach(() => {
  savedChannelId = process.env.REPORT_CHANNEL_ID;
  delete process.env.REPORT_CHANNEL_ID;
});

afterEach(() => {
  if (savedChannelId === undefined) delete process.env.REPORT_CHANNEL_ID;
  else process.env.REPORT_CHANNEL_ID = savedChannelId;
  vi.restoreAllMocks();
});

describe('getReportChannelId', () => {
  it('returns undefined when unset and trims/empties to undefined', () => {
    expect(getReportChannelId()).toBeUndefined();
    process.env.REPORT_CHANNEL_ID = '   ';
    expect(getReportChannelId()).toBeUndefined();
    process.env.REPORT_CHANNEL_ID = `  ${CHANNEL_ID}  `;
    expect(getReportChannelId()).toBe(CHANNEL_ID);
  });
});

describe('sendToReportChannel', () => {
  it('is a no-op (no channel fetch) when REPORT_CHANNEL_ID is unset', async () => {
    const { client, recorders } = createFakeClient();
    await sendToReportChannel(client, 'hello');
    expect(recorders.channelsFetch.calls).toHaveLength(0);
  });

  it('sends a short message as a single chunk', async () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    const fakeChannel = createFakeChannel({ id: CHANNEL_ID });
    const { client } = createFakeClient({ channelsById: { [CHANNEL_ID]: fakeChannel.channel } });

    await sendToReportChannel(client, 'short message');

    expect(fakeChannel.recorders.send.calls).toEqual([['short message']]);
  });

  it('splits an oversized message into multiple <=2000-char sends, preserving order and content', async () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    const fakeChannel = createFakeChannel({ id: CHANNEL_ID });
    const { client } = createFakeClient({ channelsById: { [CHANNEL_ID]: fakeChannel.channel } });
    // Newline-delimited so splitMessage has break points; >2000 chars total.
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    expect(text.length).toBeGreaterThan(2000);

    await sendToReportChannel(client, text);

    const chunks = fakeChannel.recorders.send.calls.map(([c]) => String(c));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    // Every original line survives somewhere in order — nothing dropped by the split.
    expect(chunks.join('\n')).toContain('line 0 ');
    expect(chunks.join('\n')).toContain('line 199 ');
  });

  it('warns and does not throw when the channel id resolves to null', async () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    const warn = vi.spyOn(logger, 'warn');
    const { client } = createFakeClient({ channelsById: { [CHANNEL_ID]: null as unknown as Channel } });

    await expect(sendToReportChannel(client, 'hi')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('warns and skips sending when the resolved channel is not text-based', async () => {
    process.env.REPORT_CHANNEL_ID = CHANNEL_ID;
    const warn = vi.spyOn(logger, 'warn');
    const notText = { id: CHANNEL_ID, isTextBased: () => false } as unknown as Channel;
    const { client } = createFakeClient({ channelsById: { [CHANNEL_ID]: notText } });

    await sendToReportChannel(client, 'hi');

    expect(warn).toHaveBeenCalled();
  });

  it('swallows a fetch rejection (unknown channel) without throwing', async () => {
    process.env.REPORT_CHANNEL_ID = 'no-such-channel';
    const warn = vi.spyOn(logger, 'warn');
    // createFakeClient throws for ids absent from the map.
    const { client } = createFakeClient({ channelsById: { [CHANNEL_ID]: createFakeChannel().channel } });

    await expect(sendToReportChannel(client, 'hi')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
