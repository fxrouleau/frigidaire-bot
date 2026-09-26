import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Client, type ClientEvents, Events } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defineEvent,
  type EventModule,
  isEventModule,
  type LoadedEventModule,
  registerEventModules,
  resolveEventModule,
} from './eventModule';
import { logger } from './logger';

/** A plain emitter standing in for the Discord client (only on/once/emit/listenerCount are used). */
function fakeClient(): EventEmitter & Pick<Client, 'on' | 'once'> {
  return new EventEmitter() as EventEmitter & Pick<Client, 'on' | 'once'>;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('defineEvent', () => {
  it('defaults once to false and keeps the handler', () => {
    const handler = defineEvent(Events.MessageCreate, { execute: () => 'ok' });
    expect(handler.name).toBe('messageCreate');
    expect(handler.once).toBe(false);
    expect(handler.execute.length).toBe(0);
  });

  it('records once handlers', () => {
    expect(defineEvent(Events.ClientReady, { once: true, execute: () => undefined }).once).toBe(true);
  });
});

describe('resolveEventModule', () => {
  it('accepts a default export and a bare module object, rejects anything else', () => {
    const event = defineEvent(Events.MessageCreate, { execute: () => undefined });
    expect(resolveEventModule({ default: event })).toBe(event);
    expect(resolveEventModule(event)).toBe(event);
    expect(resolveEventModule({ default: { name: 'x' } })).toBeUndefined();
    expect(resolveEventModule(null)).toBeUndefined();
    expect(isEventModule({ name: 'messageCreate', execute: () => 1 })).toBe(true);
  });
});

describe('registerEventModules', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // What app.ts gets from resolveEventModule(): the event type is only known at runtime.
  const loaded = <K extends keyof ClientEvents>(file: string, event: EventModule<K>): LoadedEventModule => ({
    file,
    event: event as unknown as EventModule,
  });

  it('adds ONE client listener per event (and per once-event), however many modules handle it', async () => {
    const client = fakeClient();
    const modules = [
      ...Array.from({ length: 12 }, (_, i) =>
        loaded(`message${i}.ts`, defineEvent(Events.MessageCreate, { execute: () => undefined })),
      ),
      ...Array.from({ length: 11 }, (_, i) =>
        loaded(`ready${i}.ts`, defineEvent(Events.ClientReady, { once: true, execute: () => undefined })),
      ),
      loaded('delete.ts', defineEvent(Events.MessageDelete, { execute: () => undefined })),
    ];
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on('warning', onWarning);
    try {
      expect(registerEventModules(client, modules)).toBe(3);
      // Node emits the leak warning on the next tick.
      await settle();
    } finally {
      process.off('warning', onWarning);
    }

    expect(client.listenerCount(Events.MessageCreate)).toBe(1);
    expect(client.listenerCount(Events.ClientReady)).toBe(1);
    expect(client.listenerCount(Events.MessageDelete)).toBe(1);
    expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([]);
  });

  it('hands every module the event and its arguments, in load order', async () => {
    const client = fakeClient();
    const calls: string[] = [];
    const handler = (name: string) =>
      defineEvent(Events.MessageCreate, {
        execute: (message) => {
          calls.push(`${name}:${String(message)}`);
        },
      });
    registerEventModules(client, [loaded('a.ts', handler('a')), loaded('b.ts', handler('b')), loaded('c.ts', handler('c'))]);

    client.emit(Events.MessageCreate, 'm1');
    client.emit(Events.MessageCreate, 'm2');
    await settle();

    expect(calls).toEqual(['a:m1', 'b:m1', 'c:m1', 'a:m2', 'b:m2', 'c:m2']);
  });

  it("never lets one handler's throw, rejection or hang stop or delay the others, and logs the failures", async () => {
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const client = fakeClient();
    const reached: string[] = [];
    const record = (name: string) =>
      defineEvent(Events.MessageCreate, {
        execute: () => {
          reached.push(name);
        },
      });
    registerEventModules(client, [
      loaded('throws.ts', defineEvent(Events.MessageCreate, { execute: () => { throw new Error('sync boom'); } })),
      loaded('first.ts', record('first')),
      loaded('rejects.ts', defineEvent(Events.MessageCreate, { execute: async () => { throw new Error('async boom'); } })),
      loaded('hangs.ts', defineEvent(Events.MessageCreate, { execute: () => new Promise(() => {}) })),
      loaded('last.ts', record('last')),
    ]);

    expect(() => client.emit(Events.MessageCreate, 'm1')).not.toThrow();
    await settle();

    expect(reached).toEqual(['first', 'last']);
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([
      'Event handler throws.ts (messageCreate) failed:',
      'Event handler rejects.ts (messageCreate) failed:',
    ]);
  });

  it('runs once-handlers on the first event only; the same event can have both kinds', async () => {
    const client = fakeClient();
    let onceCalls = 0;
    let everyCalls = 0;
    registerEventModules(client, [
      loaded('ready-once.ts', defineEvent(Events.ClientReady, { once: true, execute: () => void onceCalls++ })),
      loaded('ready-every.ts', defineEvent(Events.ClientReady, { execute: () => void everyCalls++ })),
      loaded('ready-once-2.ts', defineEvent(Events.ClientReady, { once: true, execute: () => void onceCalls++ })),
    ]);
    expect(client.listenerCount(Events.ClientReady)).toBe(2);

    client.emit(Events.ClientReady, 'client');
    client.emit(Events.ClientReady, 'client');
    await settle();

    expect([onceCalls, everyCalls]).toEqual([2, 2]);
    expect(client.listenerCount(Events.ClientReady)).toBe(1);
  });
});

describe('src/events/', () => {
  const eventsDir = path.join(__dirname, 'events');
  const files = fs.readdirSync(eventsDir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));

  it('gets exactly one client listener per event once registered', async () => {
    const modules: LoadedEventModule[] = [];
    for (const file of files) {
      const event = resolveEventModule(await import(`./events/${file}`));
      if (event) modules.push({ file, event });
    }
    const client = fakeClient();

    registerEventModules(client, modules);

    const names = [...new Set(modules.map((m) => m.event.name))];
    // Several events have many handler files (11 each on messageCreate and clientReady when this was written:
    // one listener per file went past Node's default limit of 10).
    expect(Math.max(...names.map((name) => modules.filter((m) => m.event.name === name).length))).toBeGreaterThan(1);
    for (const name of names) {
      const kinds = new Set(modules.filter((m) => m.event.name === name).map((m) => m.event.once)).size;
      expect(client.listenerCount(name), name).toBe(kinds);
    }
  });

  it('contains handlers', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${file} exports a valid event module the loader will accept`, async () => {
      const loaded = await import(`./events/${file}`);
      const event = resolveEventModule(loaded);
      expect(event, `${file} must export default defineEvent(...)`).toBeDefined();
      expect(typeof event?.name).toBe('string');
      expect(typeof event?.execute).toBe('function');
    });
  }
});
