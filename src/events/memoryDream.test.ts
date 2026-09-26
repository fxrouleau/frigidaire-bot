import type { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import memoryDream, { resetMemoryDreamForTesting } from './memoryDream';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  resetMemoryDreamForTesting();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const client = {} as Client<true>;

describe('memoryDream', () => {
  it('is a once-only ClientReady handler', () => {
    expect(memoryDream.name).toBe('clientReady');
    expect(memoryDream.once).toBe(true);
  });

  it('starts the nightly schedule once, and not at all with MEMORY_DREAM_ENABLED=false', () => {
    vi.stubEnv('MEMORY_DREAM_ENABLED', 'false');
    memoryDream.execute(client);
    expect(vi.getTimerCount()).toBe(0);

    vi.stubEnv('MEMORY_DREAM_ENABLED', 'true');
    memoryDream.execute(client);
    memoryDream.execute(client);
    expect(vi.getTimerCount()).toBe(2);
    resetMemoryDreamForTesting();
    expect(vi.getTimerCount()).toBe(0);
  });
});
