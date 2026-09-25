import { describe, expect, it } from 'vitest';
import { ClipCache } from './clipCache';

const clip = (bytes: number) => ({ data: Buffer.alloc(bytes), contentType: 'video/mp4' });

describe('ClipCache', () => {
  it('returns a clip until it expires', () => {
    let now = 0;
    const cache = new ClipCache({ ttlMs: 1000, now: () => now });
    cache.set('a', clip(10));
    expect(cache.get('a')?.data.byteLength).toBe(10);
    now = 1001;
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts the least recently used clip past the entry cap', () => {
    const cache = new ClipCache({ maxEntries: 2 });
    cache.set('a', clip(1));
    cache.set('b', clip(1));
    cache.get('a');
    cache.set('c', clip(1));
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('keeps the total size under the byte cap, and skips a clip bigger than the cap', () => {
    const cache = new ClipCache({ maxBytes: 100 });
    cache.set('a', clip(60));
    cache.set('b', clip(60));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    cache.set('huge', clip(101));
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.size).toBe(1);
  });
});
