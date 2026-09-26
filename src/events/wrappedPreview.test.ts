import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeMessage } from '../test-support/fakeDiscord';
import wrappedPreviewEvent from './wrappedPreview';

const runWrappedPreview = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../archive/wrapped', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../archive/wrapped')>()),
  runWrappedPreview,
  discordWrappedDeps: () => ({ fake: 'deps' }),
}));

const REPORT = 'report-1';

describe('wrappedPreview event', () => {
  beforeEach(() => {
    runWrappedPreview.mockClear();
    vi.stubEnv('REPORT_CHANNEL_ID', REPORT);
    vi.stubEnv('ARCHIVE_ENABLED', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('listens to messages', () => {
    expect(wrappedPreviewEvent.name).toBe('messageCreate');
    expect(wrappedPreviewEvent.once).toBeFalsy();
  });

  it('runs a preview for `!wrapped` and `!wrapped <year>` in the report channel', async () => {
    await wrappedPreviewEvent.execute(createFakeMessage({ channelId: REPORT, content: '!wrapped' }).message);
    await wrappedPreviewEvent.execute(createFakeMessage({ channelId: REPORT, content: '!wrapped 2025' }).message);
    expect(runWrappedPreview.mock.calls).toEqual([
      [{ channelId: REPORT }, { fake: 'deps' }],
      [{ channelId: REPORT, year: 2025 }, { fake: 'deps' }],
    ]);
  });

  it('ignores other channels, other text, bots, webhooks, and a disabled archive or report channel', async () => {
    await wrappedPreviewEvent.execute(createFakeMessage({ channelId: 'main-1', content: '!wrapped' }).message);
    await wrappedPreviewEvent.execute(createFakeMessage({ channelId: REPORT, content: 'wrapped when?' }).message);
    await wrappedPreviewEvent.execute(
      createFakeMessage({ channelId: REPORT, content: '!wrapped', authorIsBot: true }).message,
    );
    await wrappedPreviewEvent.execute(
      createFakeMessage({ channelId: REPORT, content: '!wrapped', webhookId: 'wh-1' }).message,
    );
    vi.stubEnv('ARCHIVE_ENABLED', 'false');
    await wrappedPreviewEvent.execute(createFakeMessage({ channelId: REPORT, content: '!wrapped' }).message);
    vi.stubEnv('ARCHIVE_ENABLED', '');
    vi.stubEnv('REPORT_CHANNEL_ID', '');
    await wrappedPreviewEvent.execute(createFakeMessage({ channelId: REPORT, content: '!wrapped' }).message);
    expect(runWrappedPreview).not.toHaveBeenCalled();
  });
});
