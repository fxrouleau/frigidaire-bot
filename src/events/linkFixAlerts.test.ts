import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportPlatformHealth, resetPlatformHealthForTesting } from '../links/fixerHealth';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { createFakeChannel, createFakeClient } from '../test-support/fakeDiscord';
import linkFixAlertsEvent from './linkFixAlerts';

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('linkFixAlerts event', () => {
  beforeEach(() => {
    resetPlatformHealthForTesting();
    setBotDbForTesting(new BotDb(':memory:'));
  });

  afterEach(() => {
    resetPlatformHealthForTesting();
    setBotDbForTesting(undefined);
    vi.unstubAllEnvs();
  });

  it('runs once on ClientReady', () => {
    expect(linkFixAlertsEvent.name).toBe('clientReady');
    expect(linkFixAlertsEvent.once).toBe(true);
  });

  it('posts platform outages and recoveries to the report channel', async () => {
    vi.stubEnv('REPORT_CHANNEL_ID', 'report-1');
    const report = createFakeChannel({ id: 'report-1' });
    const { client } = createFakeClient({ channelsById: { 'report-1': report.channel } });

    await linkFixAlertsEvent.execute(client);
    reportPlatformHealth('instagram', 'down', Date.now(), 'instagram7.com: down');
    await flush();
    reportPlatformHealth('instagram', 'up', Date.now(), 'uuinstagram.com');
    await flush();

    const posts = report.recorders.send.calls.map((call) => String(call[0]));
    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain('Instagram link fixing is down');
    expect(posts[0]).toContain('instagram7.com: down');
    expect(posts[1]).toContain('Instagram link fixing works again');
  });

  it('stays off without a report channel', async () => {
    const report = createFakeChannel({ id: 'report-1' });
    const { client, recorders } = createFakeClient({ channelsById: { 'report-1': report.channel } });

    await linkFixAlertsEvent.execute(client);
    reportPlatformHealth('tiktok', 'down', Date.now(), 'x');
    await flush();

    expect(recorders.channelsFetch.calls).toEqual([]);
  });

  it('stays off with LINK_FIX_ALERTS=false', async () => {
    vi.stubEnv('REPORT_CHANNEL_ID', 'report-1');
    vi.stubEnv('LINK_FIX_ALERTS', 'false');
    const report = createFakeChannel({ id: 'report-1' });
    const { client } = createFakeClient({ channelsById: { 'report-1': report.channel } });

    await linkFixAlertsEvent.execute(client);
    reportPlatformHealth('tiktok', 'down', Date.now(), 'x');
    await flush();

    expect(report.recorders.send.calls).toEqual([]);
  });
});
