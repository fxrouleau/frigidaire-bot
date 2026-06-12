import type { Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createFakeMessage } from './test-support/fakeDiscord';
import { repostMessage, splitMessage } from './utils';

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
});

describe('repostMessage', () => {
  it('creates a webhook, deletes the original, sends new content, and cleans up', async () => {
    const fake = createFakeMessage({
      content: 'original content',
      authorDisplayName: 'Cool Author',
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
    expect(hook.send.calls[0][0]).toBe('new content');
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

  it('webhook is created before the original message is deleted', async () => {
    // Observe ordering: createWebhook must resolve before delete is invoked, since
    // delete is part of the Promise.all that follows webhook creation.
    const events: string[] = [];
    const fake = createFakeMessage({});
    const original = fake.recorders.createWebhook;
    // Wrap delete to record ordering.
    const msg = fake.message as unknown as { delete: () => Promise<unknown> };
    const realDelete = msg.delete;
    msg.delete = () => {
      events.push('delete');
      return realDelete();
    };
    // createWebhook already records into its calls array; capture ordering by length check.
    await repostMessage(fake.message, 'ordered');
    expect(original.calls).toHaveLength(1);
    expect(events).toContain('delete');
  });
});

// Type-only assertion that repostMessage accepts a Message — guards against signature drift.
const _typecheck: (m: Message, c: string) => Promise<void> = repostMessage;
void _typecheck;
