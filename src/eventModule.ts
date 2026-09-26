// The contract every file in src/events/ fulfils. app.ts loads each file, validates it against this
// shape at startup, and registers it on the Discord client (registerEventModules) behind a dispatcher that
// logs (instead of crashing on) a rejected or throwing handler.
import type { Client, ClientEvents } from 'discord.js';
import { logger } from './logger';

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

/** An event module and the file it came from (for log lines). */
export type LoadedEventModule = { file: string; event: EventModule };

/** Calls one handler without letting it throw or reject into anyone else: failures are logged. */
function dispatchSafely({ file, event }: LoadedEventModule, args: unknown[]): void {
  Promise.resolve()
    .then(() => (event.execute as (...a: unknown[]) => unknown)(...args))
    .catch((error) => logger.error(`Event handler ${file} (${event.name}) failed:`, error));
}

/**
 * Registers the event modules on the client: ONE listener per (event, once) that hands the event to every
 * module for it, in load order. A listener per module put 11 on messageCreate and clientReady, past Node's
 * default of 10, and the "possible EventEmitter memory leak" warning is only useful if it stays quiet until
 * there is a real leak. Each handler starts on its own promise chain, as with one listener each: they run
 * concurrently, and one that throws, rejects or never settles neither stops nor delays the others.
 * Returns the number of listeners added.
 */
export function registerEventModules(client: Pick<Client, 'on' | 'once'>, modules: LoadedEventModule[]): number {
  const groups = new Map<string, { name: keyof ClientEvents; once: boolean; members: LoadedEventModule[] }>();
  for (const loaded of modules) {
    const key = `${loaded.event.once ? 'once' : 'on'}:${loaded.event.name}`;
    const group = groups.get(key) ?? { name: loaded.event.name, once: loaded.event.once, members: [] };
    group.members.push(loaded);
    groups.set(key, group);
  }
  for (const { name, once, members } of groups.values()) {
    const listener = (...args: unknown[]) => {
      for (const member of members) dispatchSafely(member, args);
    };
    if (once) client.once(name, listener);
    else client.on(name, listener);
  }
  return groups.size;
}
