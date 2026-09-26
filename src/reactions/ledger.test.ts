import { beforeEach, describe, expect, it } from 'vitest';
import { BotDb } from '../storage/botDb';
import { type AutoReactRecord, AutoReactLedger } from './ledger';

const T0 = Date.UTC(2026, 8, 25, 16, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const LIMITS = { maxPerDay: 3, minGapMs: 45 * MIN };

let db: BotDb;
let ledger: AutoReactLedger;

beforeEach(() => {
  db = new BotDb(':memory:');
  ledger = new AutoReactLedger(() => db);
});

function record(messageId: string, createdAt: number, mode: 'shadow' | 'on' = 'on'): AutoReactRecord {
  return { messageId, channelId: 'c1', emoji: '😂', why: 'funny', mode, createdAt };
}

describe('AutoReactLedger', () => {
  it('allows a reaction when nothing was spent', () => {
    expect(ledger.check(T0, LIMITS)).toEqual({ allowed: true });
  });

  it('enforces the minimum gap after the last reaction', () => {
    ledger.claim(record('m1', T0));
    expect(ledger.check(T0 + 44 * MIN, LIMITS)).toEqual({ allowed: false, reason: 'gap', until: T0 + 45 * MIN });
    expect(ledger.check(T0 + 45 * MIN, LIMITS)).toEqual({ allowed: true });
  });

  it('caps reactions in any rolling 24 hours, shadow ones included', () => {
    ledger.claim(record('m1', T0, 'shadow'));
    ledger.claim(record('m2', T0 + 2 * HOUR));
    ledger.claim(record('m3', T0 + 4 * HOUR, 'shadow'));
    expect(ledger.check(T0 + 10 * HOUR, LIMITS)).toEqual({ allowed: false, reason: 'daily_cap', until: T0 + 24 * HOUR });
    // The first one ages out after 24 hours.
    expect(ledger.check(T0 + 24 * HOUR + 1, LIMITS)).toEqual({ allowed: true });
  });

  it('never allows anything with a zero budget', () => {
    expect(ledger.check(T0, { maxPerDay: 0, minGapMs: 0 })).toMatchObject({ allowed: false, reason: 'daily_cap' });
  });

  it('claims a message once, and a released claim gives the slot back', () => {
    expect(ledger.claim(record('m1', T0))).toBe(true);
    expect(ledger.claim(record('m1', T0 + 1))).toBe(false);
    expect(ledger.has('m1')).toBe(true);
    ledger.release('m1');
    expect(ledger.has('m1')).toBe(false);
    expect(ledger.check(T0 + 1, LIMITS)).toEqual({ allowed: true });
  });

  it('lists recent records newest first and survives a new ledger on the same database', () => {
    ledger.claim(record('m1', T0));
    ledger.claim(record('m2', T0 + HOUR, 'shadow'));
    const reopened = new AutoReactLedger(() => db);
    expect(reopened.since(T0).map((r) => [r.messageId, r.mode])).toEqual([
      ['m2', 'shadow'],
      ['m1', 'on'],
    ]);
    expect(reopened.since(T0 + 1).map((r) => r.messageId)).toEqual(['m2']);
  });
});
