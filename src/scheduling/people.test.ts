import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setMemoryStoreForTesting } from '../ai/memory';
import { MemoryStore } from '../ai/memory/memoryStore';
import { recordRelay } from '../relay';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { createFakeMessage } from '../test-support/fakeDiscord';
import { buildDirectory, currentName, requesterOf, resolvePeople, resolvePerson } from './people';

const FELIX = '100000000000000001';
const JASON = '100000000000000002';
const JAY = '100000000000000003';
const MARIE = '100000000000000004';

let store: MemoryStore;

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  store = new MemoryStore(':memory:');
  setMemoryStoreForTesting(store);
  store.upsertIdentity(FELIX, 'fridge enjoyer');
  store.updateIdentityMeta(FELIX, { irl_name: 'Felix Rouleau', aliases_add: ['Flex'] });
  store.upsertIdentity(JASON, 'Wheezer');
  store.updateIdentityMeta(JASON, { irl_name: 'Jason' });
  store.upsertIdentity(JAY, 'Jaybird');
  store.upsertIdentity(MARIE, 'Mariè');
});

afterEach(() => {
  setMemoryStoreForTesting(undefined);
  setBotDbForTesting(undefined);
});

function directoryFor(opts: Parameters<typeof createFakeMessage>[0] = {}) {
  return buildDirectory(createFakeMessage({ authorId: FELIX, authorDisplayName: 'fridge enjoyer', ...opts }).message);
}

function resolvedId(ref: string, dir = directoryFor()): string | undefined {
  const result = resolvePerson(ref, dir);
  return result.ok ? result.person.userId : undefined;
}

describe('resolvePerson', () => {
  it('resolves display names, IRL names (full or first), aliases and canonical names, case-insensitively', () => {
    expect(resolvedId('wheezer')).toBe(JASON);
    expect(resolvedId('@Wheezer')).toBe(JASON);
    expect(resolvedId('Jason')).toBe(JASON);
    expect(resolvedId('felix rouleau')).toBe(FELIX);
    expect(resolvedId('Felix')).toBe(FELIX);
    expect(resolvedId('flex')).toBe(FELIX);
  });

  it('ignores accents and surrounding quotes', () => {
    expect(resolvedId('Marie')).toBe(MARIE);
    expect(resolvedId('"Mariè"')).toBe(MARIE);
  });

  it('resolves mention tokens and raw ids of known people', () => {
    expect(resolvedId(`<@${JASON}>`)).toBe(JASON);
    expect(resolvedId(`<@!${JASON}>`)).toBe(JASON);
    expect(resolvedId(JAY)).toBe(JAY);
  });

  it('rejects an id nobody knows', () => {
    const result = resolvePerson('<@999999999999999999>', directoryFor());
    expect(result).toEqual({ ok: false, error: "I don't know anyone with id 999999999999999999 in this server." });
  });

  it('maps "me" to the requester', () => {
    expect(resolvedId('me')).toBe(FELIX);
    expect(resolvedId('Myself')).toBe(FELIX);
  });

  it('refuses crowds', () => {
    const result = resolvePerson('@everyone', directoryFor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('specific people');
  });

  it('falls back to a unique prefix of 3+ characters', () => {
    expect(resolvedId('whee')).toBe(JASON);
    expect(resolvedId('jas')).toBe(JASON); // only Jason's IRL name starts with "jas"
    // Two letters are too short for a prefix match, and match no whole name or word.
    expect(resolvedId('ja')).toBeUndefined();
  });

  it('reports ambiguity with ids instead of guessing', () => {
    store.upsertIdentity('100000000000000005', 'Jaylen');
    const twoJays = resolvePerson('jay', directoryFor());
    expect(twoJays.ok).toBe(false);
    if (!twoJays.ok) {
      expect(twoJays.error).toContain(`Jaybird (id:${JAY})`);
      expect(twoJays.error).toContain('Jaylen (id:100000000000000005)');
    }
  });

  it('lists the people it knows when nothing matches', () => {
    const result = resolvePerson('Gandalf', directoryFor());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('I don\'t know who "Gandalf" is.');
      expect(result.error).toContain('Wheezer');
    }
  });

  it('knows people mentioned in the message even before the identity tracker has seen them', () => {
    const dir = directoryFor({
      mentionedUsers: [{ id: '100000000000000009', displayName: 'Newcomer', username: 'newcomer99' }],
    });
    expect(resolvedId('newcomer', dir)).toBe('100000000000000009');
    expect(resolvedId('newcomer99', dir)).toBe('100000000000000009');
    expect(resolvedId('<@100000000000000009>', dir)).toBe('100000000000000009');
  });

  it('never resolves to the bot itself', () => {
    const dir = directoryFor({ mentionedUsers: [{ id: 'bot-1', displayName: 'Frigidaire' }] });
    expect(resolvePerson('Frigidaire', dir).ok).toBe(false);
  });
});

describe('resolvePeople', () => {
  it('deduplicates people named twice and stops at the first unknown', () => {
    const dir = directoryFor();
    expect(resolvePeople(['Wheezer', 'jason', 'me'], dir)).toEqual({
      ok: true,
      people: [
        { userId: JASON, name: 'Wheezer' },
        { userId: FELIX, name: 'fridge enjoyer' },
      ],
    });
    expect(resolvePeople(['Wheezer', 'Gandalf'], dir).ok).toBe(false);
  });
});

describe('requesterOf', () => {
  it('attributes a relayed webhook message to the member it was posted for', () => {
    recordRelay({
      messageId: 'relay-1',
      channelId: 'channel-1',
      authorId: JASON,
      authorName: 'Wheezer',
      kind: 'link_fix',
    });
    const relayed = createFakeMessage({ messageId: 'relay-1', webhookId: 'hook-1', authorId: 'hook-1' }).message;
    expect(requesterOf(relayed)).toEqual({ userId: JASON, name: 'Wheezer' });
  });

  it('uses the author of a regular message', () => {
    const message = createFakeMessage({ authorId: JAY, authorDisplayName: 'Jaybird' }).message;
    expect(requesterOf(message)).toEqual({ userId: JAY, name: 'Jaybird' });
  });
});

describe('currentName', () => {
  it('prefers the identity display name and falls back otherwise', () => {
    expect(currentName(JASON, 'old name')).toBe('Wheezer');
    expect(currentName('unknown', 'fallback')).toBe('fallback');
  });
});
