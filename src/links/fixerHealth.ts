// Per-platform health of link fixing as a whole ("can Instagram links be fixed right now?"), on top
// of the per-domain cooldowns in embedFixers.ts. The fixer engine reports a verdict after each
// conclusive selection; listeners (the report-channel alerts) hear about every state change.
import { logger } from '../logger';
import { PLATFORM_LABELS, type Platform } from './platforms';

export type PlatformState = 'up' | 'down';

export type PlatformHealthChange = {
  platform: Platform;
  state: PlatformState;
  /** 'unknown' on the first verdict since startup — listeners compare against what they last announced. */
  previous: PlatformState | 'unknown';
  at: number;
  /** Down: every fixer with its last result. Up: the fixer that worked. */
  detail: string;
};

export type PlatformHealthListener = (change: PlatformHealthChange) => void;

const states = new Map<Platform, PlatformState>();
const listeners = new Set<PlatformHealthListener>();

/** Subscribes to state changes; returns the unsubscribe function. */
export function onPlatformHealthChange(listener: PlatformHealthListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function platformHealth(platform: Platform): PlatformState | 'unknown' {
  return states.get(platform) ?? 'unknown';
}

/** Records a verdict for a platform; listeners run only when it changes the platform's state. */
export function reportPlatformHealth(platform: Platform, state: PlatformState, at: number, detail: string): void {
  const previous = platformHealth(platform);
  if (previous === state) return;
  states.set(platform, state);

  if (state === 'down') {
    logger.warn(`linkfix: every ${PLATFORM_LABELS[platform]} fixer is down (${detail})`);
  } else if (previous === 'down') {
    logger.info(`linkfix: ${PLATFORM_LABELS[platform]} link fixing recovered via ${detail}`);
  }

  const change: PlatformHealthChange = { platform, state, previous, at, detail };
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (error) {
      logger.warn('linkfix: platform health listener failed:', error);
    }
  }
}

/** Test-only: forgets every platform's state and every listener. */
export function resetPlatformHealthForTesting(): void {
  states.clear();
  listeners.clear();
}
