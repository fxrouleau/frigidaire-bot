import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMemoryStore, setMemoryStoreForTesting } from '../ai/memory';
import { MemoryStore } from '../ai/memory/memoryStore';
import { createFakeMessage } from '../test-support/fakeDiscord';
import identityTracker from './identityTracker';

describe('identityTracker event', () => {
  beforeEach(() => {
    setMemoryStoreForTesting(new MemoryStore(':memory:'));
  });

  afterEach(() => {
    setMemoryStoreForTesting(undefined);
  });

  it('keeps the identity on the member’s current server display name', () => {
    identityTracker.execute(createFakeMessage({ authorId: 'u1', authorDisplayName: 'Wheezer' }).message);
    identityTracker.execute(createFakeMessage({ authorId: 'u1', authorDisplayName: 'Wheez' }).message);

    const identity = getMemoryStore().getIdentityById('u1');
    expect(identity?.display_name).toBe('Wheez');
    expect(identity?.canonical_name).toBe('Wheezer');
  });

  it('falls back to the global display name, not the username, when there is no member', () => {
    identityTracker.execute(
      createFakeMessage({ authorId: 'u2', authorDisplayName: 'Jason', authorUsername: 'jason_1999', memberIsNull: true }).message,
    );
    expect(getMemoryStore().getIdentityById('u2')?.display_name).toBe('Jason');
  });

  it('records the Discord handle and keeps it current', () => {
    identityTracker.execute(createFakeMessage({ authorId: 'u3', authorDisplayName: 'Jason', authorUsername: 'cigalefourmi' }).message);
    expect(getMemoryStore().getIdentityById('u3')?.username).toBe('cigalefourmi');

    identityTracker.execute(createFakeMessage({ authorId: 'u3', authorDisplayName: 'Jason', authorUsername: 'cigale2' }).message);
    expect(getMemoryStore().getIdentityById('u3')?.username).toBe('cigale2');
  });

  it('ignores bots and webhook posts (relays are attributed through the relay registry)', () => {
    identityTracker.execute(createFakeMessage({ authorId: 'b1', authorIsBot: true }).message);
    identityTracker.execute(createFakeMessage({ authorId: 'w1', webhookId: 'wh' }).message);
    expect(getMemoryStore().getAllIdentities()).toEqual([]);
  });
});
