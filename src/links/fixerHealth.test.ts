import { afterEach, describe, expect, it } from 'vitest';
import {
  type PlatformHealthChange,
  onPlatformHealthChange,
  platformHealth,
  reportPlatformHealth,
  resetPlatformHealthForTesting,
} from './fixerHealth';

afterEach(() => {
  resetPlatformHealthForTesting();
});

describe('platform health', () => {
  it('notifies listeners on state changes only', () => {
    const changes: PlatformHealthChange[] = [];
    onPlatformHealthChange((change) => changes.push(change));

    reportPlatformHealth('reddit', 'up', 1, 'vxreddit.com');
    reportPlatformHealth('reddit', 'up', 2, 'vxreddit.com');
    reportPlatformHealth('reddit', 'down', 3, 'vxreddit.com: down, rxddit.com: down');
    reportPlatformHealth('reddit', 'down', 4, 'same');

    expect(changes.map((c) => [c.state, c.previous, c.at])).toEqual([
      ['up', 'unknown', 1],
      ['down', 'up', 3],
    ]);
    expect(platformHealth('reddit')).toBe('down');
    expect(platformHealth('bluesky')).toBe('unknown');
  });

  it('isolates a throwing listener from the others and from the reporter', () => {
    const seen: string[] = [];
    onPlatformHealthChange(() => {
      throw new Error('boom');
    });
    onPlatformHealthChange((change) => seen.push(change.platform));

    expect(() => reportPlatformHealth('tiktok', 'down', 1, 'x')).not.toThrow();
    expect(seen).toEqual(['tiktok']);
  });

  it('unsubscribes', () => {
    const seen: string[] = [];
    const off = onPlatformHealthChange((change) => seen.push(change.platform));
    off();
    reportPlatformHealth('tiktok', 'down', 1, 'x');
    expect(seen).toEqual([]);
  });
});
