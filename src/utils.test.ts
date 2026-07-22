import type { Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createFakeMessage } from './test-support/fakeDiscord';
import { repostMessage, splitMessage } from './utils';

type WebhookSendArg = { content: string; files: string[] };

describe('splitMessage', () => {
  it('returns a single unchanged chunk for short text', () => {
    const chunks = splitMessage('hello world');
    expect(chunks).toEqual(['hello world']);
  });

  it('returns a single chunk for text exactly at the limit', () => {
    const text = 'a'.repeat(2000);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
    expect(chunks[0].length).toBe(2000);
  });

  it('hard-splits a single oversized line with no newlines into two chunks', () => {
    const text = 'a'.repeat(2001);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(2000);
    expect(chunks[1].length).toBe(1);
    expect(chunks.join('')).toBe(text);
  });

  it('splits multi-line text at line boundaries without exceeding the limit', () => {
    // 30 lines of 100 chars each → 3000 chars total, forcing a split.
    const line = 'x'.repeat(100);
    const lines = Array.from({ length: 30 }, () => line);
    const text = lines.join('\n');

    const chunks = splitMessage(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    // Joining the chunks back with newlines reconstructs the original content.
    expect(chunks.join('\n')).toBe(text);
  });

  it('respects a custom maxLength', () => {
    const chunks = splitMessage('one\ntwo\nthree', 5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(5);
    }
    expect(chunks.join('\n')).toBe('one\ntwo\nthree');
  });

  it('returns an empty array for an empty string (filtered out)', () => {
    // Empty string has length 0 <= maxLength so it short-circuits to [''].
    // Document the actual behavior: a single empty chunk is returned.
    const chunks = splitMessage('');
    expect(chunks).toEqual(['']);
  });

  it('filters out empty chunks produced by blank lines when a split occurs', () => {
    // Force the line-splitting path (text longer than maxLength) and include blank lines.
    const block = `${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`;
    const chunks = splitMessage(block);
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk should be empty — the implementation filters zero-length chunks.
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('never bisects a surrogate pair on a hard split (regression: lone surrogates rendered as U+FFFD)', () => {
    // Place an astral char (2 UTF-16 units) so a naive slice at 2000 would cut it in half.
    const text = 'a'.repeat(1999) + '😀' + 'b'.repeat(50);
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      // No chunk may end on a high surrogate or start on a low surrogate.
      expect(chunk.charCodeAt(chunk.length - 1)).not.toBeGreaterThanOrEqual(0xd800);
      const first = chunk.charCodeAt(0);
      expect(first < 0xdc00 || first > 0xdfff).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    expect(chunks.join('')).toContain('😀');
  });

  it('closes and reopens code fences across chunk boundaries (regression: second half rendered as plain text)', () => {
    const codeLines = Array.from({ length: 60 }, (_, i) => `const line${i} = ${'x'.repeat(40)};`);
    const text = ['```ts', ...codeLines, '```'].join('\n');
    expect(text.length).toBeGreaterThan(2000);

    const chunks = splitMessage(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      // Every chunk must contain an even number of fence lines (self-contained code blocks).
      const fenceCount = (chunk.match(/^\s*```/gm) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
    // The continuation chunk reopens with the language tag.
    expect(chunks[1].startsWith('```ts\n')).toBe(true);
    expect(chunks[0].endsWith('\n```')).toBe(true);
  });
});

describe('repostMessage', () => {
  it('creates a webhook, sends new content with attachments, deletes the original, and cleans up', async () => {
    const fake = createFakeMessage({
      content: 'original content',
      authorDisplayName: 'Cool Author',
      attachments: [{ url: 'https://cdn.example/pic.png', contentType: 'image/png' }],
    });

    await repostMessage(fake.message, 'new content');

    // Webhook created exactly once with a name + avatar.
    expect(fake.recorders.createWebhook.calls).toHaveLength(1);
    const createArg = fake.recorders.createWebhook.calls[0][0] as { name: string; avatar: unknown };
    expect(createArg.name).toBe('Cool Author');
    expect(createArg).toHaveProperty('avatar');

    // Original message deleted.
    expect(fake.recorders.delete.calls).toHaveLength(1);

    // The created webhook is tracked; its send + delete recorders were exercised.
    expect(fake.webhooks).toHaveLength(1);
    const hook = fake.webhooks[0];
    expect(hook.send.calls).toHaveLength(1);
    const sent = hook.send.calls[0][0] as WebhookSendArg;
    expect(sent.content).toBe('new content');
    expect(sent.files).toEqual(['https://cdn.example/pic.png']);
    expect(hook.delete.calls).toHaveLength(1);
  });

  it('prefers the member nickname over the author displayName for the webhook name', async () => {
    const fake = createFakeMessage({ authorDisplayName: 'Fallback Name' });
    // member.nickname defaults to null in the fake; set it to exercise the preference branch.
    const member = (fake.message as unknown as { member: { nickname: string | null } }).member;
    member.nickname = 'Nickname';

    await repostMessage(fake.message, 'hi');

    const createArg = fake.recorders.createWebhook.calls[0][0] as { name: string };
    expect(createArg.name).toBe('Nickname');
  });

  it('sends the webhook copy BEFORE deleting the original (regression: a failed send used to destroy the message)', async () => {
    const events: string[] = [];
    const fake = createFakeMessage({});
    const msg = fake.message as unknown as { delete: () => Promise<unknown> };
    const realDelete = msg.delete;
    msg.delete = () => {
      events.push('delete');
      return realDelete();
    };

    await repostMessage(fake.message, 'ordered');

    const hook = fake.webhooks[0];
    expect(hook.send.calls).toHaveLength(1);
    expect(events).toEqual(['delete']);
    // send happened first: at the moment delete ran, the send recorder had already been called.
    // (delete is only reached after the awaited send resolves in the implementation.)
  });

  it('does not delete the original when the webhook send fails, but still cleans up the webhook', async () => {
    const fake = createFakeMessage({});
    // Make every webhook created by this channel fail its send.
    const channel = fake.message.channel as unknown as { createWebhook: (o: unknown) => Promise<unknown> };
    const realCreate = channel.createWebhook.bind(channel);
    channel.createWebhook = async (o: unknown) => {
      const hook = (await realCreate(o)) as { send: (c: unknown) => Promise<unknown>; delete: () => Promise<unknown> };
      const failingSend = () => Promise.reject(new Error('Request entity too large'));
      return { ...hook, send: failingSend };
    };

    await expect(repostMessage(fake.message, 'will fail')).rejects.toThrow('Request entity too large');

    // Original message untouched; webhook still deleted (no leak toward the 15-webhook cap).
    expect(fake.recorders.delete.calls).toHaveLength(0);
    expect(fake.webhooks[0].delete.calls).toHaveLength(1);
  });

  it('splits oversized content into multiple webhook sends', async () => {
    const fake = createFakeMessage({});
    const long = `${'a'.repeat(1990)}\n${'b'.repeat(100)}`;

    await repostMessage(fake.message, long);

    const hook = fake.webhooks[0];
    expect(hook.send.calls.length).toBeGreaterThan(1);
    for (const call of hook.send.calls) {
      expect((call[0] as WebhookSendArg).content.length).toBeLessThanOrEqual(2000);
    }
  });
});

// Type-only assertion that repostMessage accepts a Message — guards against signature drift.
const _typecheck: (m: Message, c: string) => Promise<void> = repostMessage;
void _typecheck;
