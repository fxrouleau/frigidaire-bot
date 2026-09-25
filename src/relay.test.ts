import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setMemoryStoreForTesting } from './ai/memory';
import { MemoryStore } from './ai/memory/memoryStore';
import { attributeMessage, getRelay, getRelays, recordRelay } from './relay';
import { BotDb, setBotDbForTesting } from './storage/botDb';
import { createFakeMessage } from './test-support/fakeDiscord';

let store: MemoryStore;

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  store = new MemoryStore(':memory:');
  setMemoryStoreForTesting(store);
});

afterEach(() => {
  setBotDbForTesting(undefined);
  setMemoryStoreForTesting(undefined);
});

describe('relay registry', () => {
  it('records and looks up relayed messages, singly and in bulk', () => {
    recordRelay({ messageId: 'r1', channelId: 'c', authorId: 'u1', authorName: 'Jason', kind: 'link_fix', createdAt: 5 });
    recordRelay({ messageId: 'r2', channelId: 'c', authorId: 'u2', authorName: 'Simon', kind: 'regret' });

    expect(getRelay('r1')).toEqual({
      messageId: 'r1',
      channelId: 'c',
      authorId: 'u1',
      authorName: 'Jason',
      kind: 'link_fix',
      createdAt: 5,
    });
    expect(getRelay('nope')).toBeUndefined();
    const bulk = getRelays(['r1', 'r2', 'missing']);
    expect([...bulk.keys()].sort()).toEqual(['r1', 'r2']);
    expect(bulk.get('r2')?.kind).toBe('regret');
  });

  it('keeps the first record when the same message is recorded twice', () => {
    recordRelay({ messageId: 'r1', channelId: 'c', authorId: 'u1', authorName: 'Jason', kind: 'link_fix' });
    recordRelay({ messageId: 'r1', channelId: 'c', authorId: 'u9', authorName: 'Other', kind: 'regret' });
    expect(getRelay('r1')?.authorId).toBe('u1');
  });
});

describe('attributeMessage', () => {
  it('attributes a regular member message to its author', () => {
    const fake = createFakeMessage({ authorId: 'u1', authorDisplayName: 'Jason' });
    expect(attributeMessage(fake.message)).toEqual({ authorId: 'u1', authorName: 'Jason', source: 'human' });
  });

  it('treats other bots as non-human', () => {
    const fake = createFakeMessage({ authorId: 'other-bot', authorIsBot: true });
    expect(attributeMessage(fake.message)).toBeUndefined();
  });

  it('attributes a registered relay to the real author, under their current display name', () => {
    store.upsertIdentity('u1', 'Jason (new nick)');
    recordRelay({ messageId: 'relay-1', channelId: 'c', authorId: 'u1', authorName: 'Jason', kind: 'link_fix' });
    const fake = createFakeMessage({ messageId: 'relay-1', webhookId: 'wh', authorUsername: 'Jason' });
    expect(attributeMessage(fake.message)).toEqual({ authorId: 'u1', authorName: 'Jason (new nick)', source: 'relay' });
  });

  it('falls back to the webhook name for an unregistered relay from the bot’s own webhook', () => {
    store.upsertIdentity('u1', 'Jason');
    const fake = createFakeMessage({ webhookId: 'wh', authorUsername: 'jason', applicationId: 'bot-1' });
    expect(attributeMessage(fake.message)).toEqual({ authorId: 'u1', authorName: 'Jason', source: 'relay' });
  });

  it('ignores webhooks owned by other applications', () => {
    store.upsertIdentity('u1', 'Jason');
    const fake = createFakeMessage({ webhookId: 'wh', authorUsername: 'Jason', applicationId: 'some-other-app' });
    expect(attributeMessage(fake.message)).toBeUndefined();
  });
});
