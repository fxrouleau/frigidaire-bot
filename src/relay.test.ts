import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    recordRelay({ messageId: 'r1', channelId: 'c', authorId: 'u1', authorName: 'Jasper', kind: 'link_fix', createdAt: 5 });
    recordRelay({ messageId: 'r2', channelId: 'c', authorId: 'u2', authorName: 'Silas', kind: 'regret' });

    expect(getRelay('r1')).toEqual({
      messageId: 'r1',
      channelId: 'c',
      authorId: 'u1',
      authorName: 'Jasper',
      kind: 'link_fix',
      createdAt: 5,
    });
    expect(getRelay('nope')).toBeUndefined();
    const bulk = getRelays(['r1', 'r2', 'missing']);
    expect([...bulk.keys()].sort()).toEqual(['r1', 'r2']);
    expect(bulk.get('r2')?.kind).toBe('regret');
  });

  it('keeps the first record when the same message is recorded twice', () => {
    recordRelay({ messageId: 'r1', channelId: 'c', authorId: 'u1', authorName: 'Jasper', kind: 'link_fix' });
    recordRelay({ messageId: 'r1', channelId: 'c', authorId: 'u9', authorName: 'Other', kind: 'regret' });
    expect(getRelay('r1')?.authorId).toBe('u1');
  });
});

describe('attributeMessage', () => {
  it('attributes a regular member message to its author', () => {
    const fake = createFakeMessage({ authorId: 'u1', authorDisplayName: 'Jasper' });
    expect(attributeMessage(fake.message)).toEqual({ authorId: 'u1', authorName: 'Jasper', source: 'human' });
  });

  it('treats other bots as non-human', () => {
    const fake = createFakeMessage({ authorId: 'other-bot', authorIsBot: true });
    expect(attributeMessage(fake.message)).toBeUndefined();
  });

  it('attributes a registered relay to the real author, under their current display name', () => {
    store.upsertIdentity('u1', 'Jasper (new nick)');
    recordRelay({ messageId: 'relay-1', channelId: 'c', authorId: 'u1', authorName: 'Jasper', kind: 'link_fix' });
    const fake = createFakeMessage({ messageId: 'relay-1', webhookId: 'wh', authorUsername: 'Jasper' });
    expect(attributeMessage(fake.message)).toEqual({ authorId: 'u1', authorName: 'Jasper (new nick)', source: 'relay' });
  });

  it('falls back to the webhook name for an unregistered relay from the bot’s own webhook', () => {
    store.upsertIdentity('u1', 'Jasper');
    const fake = createFakeMessage({ webhookId: 'wh', authorUsername: 'jasper', applicationId: 'bot-1' });
    expect(attributeMessage(fake.message)).toEqual({ authorId: 'u1', authorName: 'Jasper', source: 'relay' });
  });

  it('ignores webhooks owned by other applications', () => {
    store.upsertIdentity('u1', 'Jasper');
    const fake = createFakeMessage({ webhookId: 'wh', authorUsername: 'Jasper', applicationId: 'some-other-app' });
    expect(attributeMessage(fake.message)).toBeUndefined();
  });

  it('does not guess between two members for an unregistered relay', () => {
    store.upsertIdentity('u1', 'Jasper');
    store.upsertIdentity('u2', 'OldJasper');
    store.upsertIdentity('u2', 'jasper');
    const fake = createFakeMessage({ webhookId: 'wh', authorUsername: 'Jasper', applicationId: 'bot-1' });
    expect(attributeMessage(fake.message)).toEqual({ authorId: undefined, authorName: 'Jasper', source: 'relay' });
  });
});

describe('attributeMessage with linked side accounts (LINKED_ACCOUNTS)', () => {
  const MAIN = '100000000000000001';
  const SIDE = '100000000000000002';

  beforeEach(() => {
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${MAIN}`);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("attributes a side account's message to the main account, under the main account's name", () => {
    store.upsertIdentity(MAIN, 'Toby');
    const fake = createFakeMessage({ authorId: SIDE, authorDisplayName: 'Tohbee' });
    expect(attributeMessage(fake.message)).toEqual({ authorId: MAIN, authorName: 'Toby', source: 'human' });
  });

  it('keeps the live side-account name when the main account is unknown', () => {
    const fake = createFakeMessage({ authorId: SIDE, authorDisplayName: 'Tohbee' });
    expect(attributeMessage(fake.message)).toEqual({ authorId: MAIN, authorName: 'Tohbee', source: 'human' });
  });

  it("attributes a relay of a side account's message to the main account", () => {
    store.upsertIdentity(MAIN, 'Toby');
    recordRelay({ messageId: 'relay-1', channelId: 'c', authorId: SIDE, authorName: 'Tohbee', kind: 'link_fix' });
    const fake = createFakeMessage({ messageId: 'relay-1', webhookId: 'wh', authorUsername: 'Tohbee' });
    expect(attributeMessage(fake.message)).toEqual({ authorId: MAIN, authorName: 'Toby', source: 'relay' });
    // The registry still records the account the original came from.
    expect(getRelay('relay-1')?.authorId).toBe(SIDE);
  });

  it("resolves an unregistered relay under the side account's name to the main account", () => {
    store.upsertIdentity(MAIN, 'Toby');
    store.upsertIdentity(SIDE, 'Tohbee');
    const fake = createFakeMessage({ webhookId: 'wh', authorUsername: 'Tohbee', applicationId: 'bot-1' });
    expect(attributeMessage(fake.message)).toEqual({ authorId: MAIN, authorName: 'Toby', source: 'relay' });
  });
});
