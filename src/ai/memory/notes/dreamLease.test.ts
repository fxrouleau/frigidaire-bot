import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../../logger';
import { MemoryStore } from '../memoryStore';
import {
  DREAM_LEASE_KEY,
  DREAM_LEASE_RENEW_MS,
  DREAM_LEASE_STALE_MS,
  type DreamLeaseResult,
  takeDreamLease,
} from './dreamLease';

// Two MemoryStores on one file: the bot and a `memory bootstrap --run` in the same container.
let dir: string;
let bot: MemoryStore;
let cli: MemoryStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-lease-'));
  const file = path.join(dir, 'memory.db');
  bot = new MemoryStore(file);
  cli = new MemoryStore(file);
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  bot.close();
  cli.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function held(result: DreamLeaseResult) {
  if (!result.ok) throw new Error(`lease held by ${result.heldBy.holder}`);
  return result.lease;
}

describe('takeDreamLease', () => {
  it('lets one process dream at a time, says who has it, and frees it on release', () => {
    const now = () => new Date('2026-09-26T08:00:00Z'); // 04:00 ET
    const nightly = held(takeDreamLease(bot, 'the nightly dream', { now }));
    expect(takeDreamLease(cli, 'the memory bootstrap (CLI)', { now })).toEqual({
      ok: false,
      heldBy: { holder: 'the nightly dream', since: '2026-09-26 04:00' },
    });
    // The holder's own process is refused too: one dream at a time, whoever asks.
    expect(takeDreamLease(bot, 'the nightly dream', { now }).ok).toBe(false);

    nightly.release();
    nightly.release();
    expect(bot.getState(DREAM_LEASE_KEY)).toBe('');
    const bootstrap = held(takeDreamLease(cli, 'the memory bootstrap (CLI)', { now }));
    expect(takeDreamLease(bot, 'the nightly dream', { now })).toMatchObject({
      ok: false,
      heldBy: { holder: 'the memory bootstrap (CLI)' },
    });
    bootstrap.release();
  });

  it('is renewed while held, and taken over once stale (its process died)', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-09-26T08:00:00Z'));
    const lease = held(takeDreamLease(bot, 'the nightly dream'));
    vi.advanceTimersByTime(DREAM_LEASE_STALE_MS * 3);
    // Renewed every DREAM_LEASE_RENEW_MS: still fresh long after the stale limit.
    expect(takeDreamLease(cli, 'the memory bootstrap (CLI)').ok).toBe(false);

    // A crashed holder stops renewing (simulated: the timer is gone, the row stays).
    const row = bot.getState(DREAM_LEASE_KEY);
    lease.release();
    bot.setState(DREAM_LEASE_KEY, row ?? '');
    vi.advanceTimersByTime(DREAM_LEASE_STALE_MS - DREAM_LEASE_RENEW_MS);
    expect(takeDreamLease(cli, 'the memory bootstrap (CLI)').ok).toBe(false);
    vi.advanceTimersByTime(DREAM_LEASE_RENEW_MS * 2);
    const takeover = held(takeDreamLease(cli, 'the memory bootstrap (CLI)'));
    expect(takeDreamLease(bot, 'the nightly dream').ok).toBe(false);
    takeover.release();
  });

  it("never frees or renews a lease someone else took over, and ignores a value that isn't a lease", () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-09-26T08:00:00Z'));
    const stale = held(takeDreamLease(bot, 'the nightly dream'));
    // The bot froze past the stale limit without renewing (its timer didn't fire): the CLI takes over.
    vi.setSystemTime(new Date(Date.now() + DREAM_LEASE_STALE_MS + 1));
    const takeover = held(takeDreamLease(cli, 'the memory bootstrap (CLI)'));
    stale.release();
    expect(takeDreamLease(bot, 'the nightly dream')).toMatchObject({
      ok: false,
      heldBy: { holder: 'the memory bootstrap (CLI)' },
    });
    takeover.release();

    bot.setState(DREAM_LEASE_KEY, 'not json');
    held(takeDreamLease(bot, 'the nightly dream')).release();
  });
});
