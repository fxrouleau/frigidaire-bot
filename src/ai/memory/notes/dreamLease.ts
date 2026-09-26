// Who is dreaming right now (docs/memory.md "Dreaming"): a lease in memory.db's bot_state, so the bot's
// nightly dream (dreamSchedule.ts) and a catch-up dream in another process on the same memory.db
// (`memory bootstrap --run` in the bot's container: runDreamsUntilCaughtUp) never run at the same time.
// Both would read the same people's journal rows and pay for the same dream calls, and the later save
// would be refused anyway (dreamer.ts compares the versions its prompt showed). Taking it is one IMMEDIATE
// transaction, so two processes can't both win; the holder renews it every DREAM_LEASE_RENEW_MS while it
// runs, and one not renewed for DREAM_LEASE_STALE_MS belongs to a process that died and is taken over.
import { randomUUID } from 'node:crypto';
import { logger } from '../../../logger';
import { formatTimestampET } from '../../utils';
import type { MemoryStore } from '../memoryStore';

/** bot_state key of the lease: JSON `{ token, holder, since, renewedAt }` (ISO times), or '' when free. */
export const DREAM_LEASE_KEY = 'dream:running';
/** How often a holder renews its lease. */
export const DREAM_LEASE_RENEW_MS = 60_000;
/** A lease not renewed for this long is stale (its process died or stopped) and may be taken over. */
export const DREAM_LEASE_STALE_MS = 10 * 60_000;

/** A lease this process holds. */
export type DreamLease = {
  /** Frees the lease (when this holder still has it) and stops renewing it. Idempotent; never throws. */
  release(): void;
};

/** Who holds a lease someone else took: their label and since when (Eastern, "YYYY-MM-DD HH:MM"). */
export type DreamLeaseHolder = { holder: string; since: string };

export type DreamLeaseResult = { ok: true; lease: DreamLease } | { ok: false; heldBy: DreamLeaseHolder };

type StoredLease = { token: string; holder: string; since: string; renewedAt: string };

function readLease(memory: MemoryStore): StoredLease | undefined {
  const raw = memory.getState(DREAM_LEASE_KEY);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<StoredLease> | null;
    if (
      typeof value?.token === 'string' &&
      typeof value.holder === 'string' &&
      typeof value.since === 'string' &&
      typeof value.renewedAt === 'string'
    ) {
      return value as StoredLease;
    }
  } catch {
    // A value that isn't a lease is no lease: it is overwritten.
  }
  return undefined;
}

function describeSince(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? formatTimestampET(new Date(ms)) : iso;
}

/**
 * Takes the dream lease for `holder` (a label for the logs and the other process: "the nightly dream")
 * unless another holder has a fresh one; renews it every DREAM_LEASE_RENEW_MS (an unref'd timer) until
 * released. Never throws on a busy lease: it says who has it.
 */
export function takeDreamLease(memory: MemoryStore, holder: string, opts: { now?: () => Date } = {}): DreamLeaseResult {
  const now = opts.now ?? (() => new Date());
  const db = memory.sharedDatabase();
  const token = randomUUID();
  const other = db
    .transaction((): StoredLease | undefined => {
      const current = readLease(memory);
      const renewed = current ? Date.parse(current.renewedAt) : Number.NaN;
      if (current && Number.isFinite(renewed) && now().getTime() - renewed < DREAM_LEASE_STALE_MS) return current;
      if (current)
        logger.warn(
          `dream: taking over a stale dream lease from ${current.holder} (last renewed ${current.renewedAt}).`,
        );
      const at = now().toISOString();
      memory.setState(
        DREAM_LEASE_KEY,
        JSON.stringify({ token, holder, since: at, renewedAt: at } satisfies StoredLease),
      );
      return undefined;
    })
    .immediate();
  if (other) return { ok: false, heldBy: { holder: other.holder, since: describeSince(other.since) } };

  /** Runs `fn` on the stored lease while it is still ours. */
  const whileOurs = (fn: (lease: StoredLease) => void) => {
    db.transaction(() => {
      const current = readLease(memory);
      if (current?.token === token) fn(current);
    }).immediate();
  };
  const timer = setInterval(() => {
    try {
      whileOurs((lease) =>
        memory.setState(DREAM_LEASE_KEY, JSON.stringify({ ...lease, renewedAt: now().toISOString() })),
      );
    } catch (error) {
      logger.warn('dream: renewing the dream lease failed:', error);
    }
  }, DREAM_LEASE_RENEW_MS);
  timer.unref?.();
  let released = false;
  return {
    ok: true,
    lease: {
      release() {
        if (released) return;
        released = true;
        clearInterval(timer);
        try {
          whileOurs(() => memory.setState(DREAM_LEASE_KEY, ''));
        } catch (error) {
          logger.warn('dream: releasing the dream lease failed (it goes stale on its own):', error);
        }
      },
    },
  };
}
