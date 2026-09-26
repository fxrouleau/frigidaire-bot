import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeMessage } from '../test-support/fakeDiscord';
import { type ContentEnricher, runEnrichers } from './enrichers';

afterEach(() => {
  vi.useRealTimers();
});

describe('runEnrichers', () => {
  it('flattens every enricher’s parts and passes the role through', async () => {
    const seen: string[] = [];
    const enrichers: ContentEnricher[] = [
      {
        name: 'a',
        enrich: async (_m, role) => {
          seen.push(`a:${role}`);
          return [{ type: 'text', text: 'from a' }];
        },
      },
      { name: 'b', enrich: async () => [{ type: 'image', url: 'https://img' }] },
    ];
    const parts = await runEnrichers(createFakeMessage().message, 'reference', enrichers);
    expect(parts).toEqual([
      { type: 'text', text: 'from a' },
      { type: 'image', url: 'https://img' },
    ]);
    expect(seen).toEqual(['a:reference']);
  });

  it('isolates a failing enricher', async () => {
    const enrichers: ContentEnricher[] = [
      {
        name: 'broken',
        enrich: async () => {
          throw new Error('nope');
        },
      },
      { name: 'ok', enrich: async () => [{ type: 'text', text: 'still here' }] },
    ];
    expect(await runEnrichers(createFakeMessage().message, 'current', enrichers)).toEqual([
      { type: 'text', text: 'still here' },
    ]);
  });

  it('drops an enricher that never settles instead of hanging the turn', async () => {
    vi.useFakeTimers();
    const enrichers: ContentEnricher[] = [
      { name: 'stuck', enrich: () => new Promise(() => {}) },
      { name: 'ok', enrich: async () => [{ type: 'text', text: 'fast' }] },
    ];
    const pending = runEnrichers(createFakeMessage().message, 'current', enrichers);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await pending).toEqual([{ type: 'text', text: 'fast' }]);
  });
});
