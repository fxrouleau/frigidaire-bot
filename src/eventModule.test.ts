import * as fs from 'node:fs';
import * as path from 'node:path';
import { Events } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { defineEvent, isEventModule, resolveEventModule } from './eventModule';

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

describe('src/events/', () => {
  const eventsDir = path.join(__dirname, 'events');
  const files = fs.readdirSync(eventsDir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));

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
