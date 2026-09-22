// The contract every file in src/events/ fulfils. app.ts loads each file, validates it against this
// shape at startup, and registers it on the Discord client behind a dispatcher that logs (instead of
// crashing on) a rejected or throwing handler.
import type { ClientEvents } from 'discord.js';

export type EventHandler<K extends keyof ClientEvents> = (...args: ClientEvents[K]) => unknown;

export type EventModule<K extends keyof ClientEvents = keyof ClientEvents> = {
  name: K;
  once: boolean;
  execute: EventHandler<K>;
};

/**
 * Declares an event handler with the listener's arguments typed from the event name:
 *   export default defineEvent(Events.MessageCreate, { execute: async (message) => { ... } });
 */
export function defineEvent<K extends keyof ClientEvents>(
  name: K,
  opts: { once?: boolean; execute: EventHandler<K> },
): EventModule<K> {
  return { name, once: opts.once ?? false, execute: opts.execute };
}

/** Runtime check used by the loader: a loaded module is only registered when it looks like an EventModule. */
export function isEventModule(value: unknown): value is EventModule {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === 'string' && typeof candidate.execute === 'function';
}

/** Accepts either `export default defineEvent(...)` (the convention) or a CommonJS-style module object. */
export function resolveEventModule(loaded: unknown): EventModule | undefined {
  if (isEventModule(loaded)) return loaded;
  const withDefault = loaded as { default?: unknown } | null | undefined;
  if (withDefault && isEventModule(withDefault.default)) return withDefault.default;
  return undefined;
}
