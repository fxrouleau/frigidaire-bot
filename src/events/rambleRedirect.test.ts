import { afterEach, describe, expect, it, vi } from 'vitest';
import { rambleWatcher } from '../gate';
import { createFakeMessage } from '../test-support/fakeDiscord';
import rambleRedirectEvent from './rambleRedirect';

describe('rambleRedirect event', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('exposes the MessageCreate event name', () => {
    expect(rambleRedirectEvent.name).toBe('messageCreate');
  });

  it('hands every message to the ramble watcher', async () => {
    const observe = vi.spyOn(rambleWatcher, 'observe').mockResolvedValue('ignored');
    const fake = createFakeMessage({ content: 'hi' });

    await rambleRedirectEvent.execute(fake.message);

    expect(observe).toHaveBeenCalledWith(fake.message);
  });

  it('is off (no decision call, no reply) until RAMBLE_USER_IDS and RAMBLE_CHANNEL_ID are set', async () => {
    vi.stubEnv('RAMBLE_USER_IDS', '');
    vi.stubEnv('RAMBLE_CHANNEL_ID', '');
    const fake = createFakeMessage({ content: 'x'.repeat(2000) });

    expect(await rambleWatcher.observe(fake.message)).toBe('off');
    expect(fake.recorders.reply.calls).toHaveLength(0);
  });
});
