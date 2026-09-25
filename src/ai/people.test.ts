import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordRelay } from '../relay';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { createFakeMessage } from '../test-support/fakeDiscord';
import { setMemoryStoreForTesting } from './memory';
import { MemoryStore } from './memory/memoryStore';
import { cleanSubject, createPeopleMatcher, findPeopleInText, matchIdentityByName, namesOf, resolvePerson } from './people';

let store: MemoryStore;

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  store = new MemoryStore(':memory:');
  setMemoryStoreForTesting(store);
  // Wheezer was first seen as "OldNick", is called Derrick IRL and "D" by the group.
  store.upsertIdentity('111111111111111111', 'OldNick');
  store.upsertIdentity('111111111111111111', 'Wheezer', 'wheezy_d');
  store.updateIdentityMeta('111111111111111111', { irl_name: 'Derrick', aliases_add: ['D', 'Wheez'] });
  // Jason's Discord handle is "cigalefourmi" (the learner once filed memories under it).
  store.upsertIdentity('222222222222222222', 'Jason', 'cigalefourmi');
  store.updateIdentityMeta('222222222222222222', { irl_name: 'Alex' });
  store.upsertIdentity('333333333333333333', 'Simon');
  store.updateIdentityMeta('333333333333333333', { irl_name: 'Alex', aliases_add: ['D'] });
});

afterEach(() => {
  setBotDbForTesting(undefined);
  setMemoryStoreForTesting(undefined);
});

describe('cleanSubject', () => {
  it('strips decoration copied from prompts', () => {
    expect(cleanSubject('@Wheezer')).toBe('Wheezer');
    expect(cleanSubject('Wheezer (id:111111111111111111)')).toBe('Wheezer');
    expect(cleanSubject(' "Jason" ')).toBe('Jason');
    expect(cleanSubject('server')).toBe('server');
  });
});

describe('namesOf', () => {
  it('lists every name a member may be filed under, current name first, without duplicates', () => {
    const identity = store.getIdentityById('111111111111111111');
    expect(namesOf(identity, ['Wheezer', ' '])).toEqual(['Wheezer', 'wheezy_d', 'OldNick', 'Derrick', 'D', 'Wheez']);
    expect(namesOf(undefined, ['Solo'])).toEqual(['Solo']);
  });
});

describe('matchIdentityByName', () => {
  const all = () => store.getAllIdentities();

  it('matches display names, Discord handles, first-seen and IRL names and aliases case-insensitively', () => {
    expect(matchIdentityByName(all(), 'wheezer')?.discord_user_id).toBe('111111111111111111');
    expect(matchIdentityByName(all(), 'CigaleFourmi')?.discord_user_id).toBe('222222222222222222');
    expect(matchIdentityByName(all(), 'OLDNICK')?.discord_user_id).toBe('111111111111111111');
    expect(matchIdentityByName(all(), 'derrick')?.discord_user_id).toBe('111111111111111111');
    expect(matchIdentityByName(all(), 'wheez')?.discord_user_id).toBe('111111111111111111');
  });

  it('never guesses between two members sharing a name', () => {
    expect(matchIdentityByName(all(), 'Alex')).toBeUndefined(); // two IRL Alexes
    expect(matchIdentityByName(all(), 'D')).toBeUndefined(); // shared alias
  });

  it('prefers a display-name match over another member’s alias', () => {
    store.updateIdentityMeta('333333333333333333', { aliases_add: ['Jason'] });
    expect(matchIdentityByName(all(), 'Jason')?.discord_user_id).toBe('222222222222222222');
  });

  it('prefers a display-name match over another member’s Discord handle', () => {
    store.upsertIdentity('444444444444444444', 'cigalefourmi');
    expect(matchIdentityByName(all(), 'cigalefourmi')?.discord_user_id).toBe('444444444444444444');
  });

  it('returns undefined for unknown or empty names', () => {
    expect(matchIdentityByName(all(), 'Nobody')).toBeUndefined();
    expect(matchIdentityByName(all(), '  ')).toBeUndefined();
  });
});

describe('resolvePerson', () => {
  it('resolves a name to the member, filed under their current display name with every known name', () => {
    expect(resolvePerson(store, 'Derrick')).toEqual({
      userId: '111111111111111111',
      displayName: 'Wheezer',
      names: ['Wheezer', 'wheezy_d', 'OldNick', 'Derrick', 'D', 'Wheez'],
    });
  });

  it('resolves a Discord handle to the member, whose names include it', () => {
    const person = resolvePerson(store, '@cigalefourmi');
    expect(person?.userId).toBe('222222222222222222');
    expect(person?.displayName).toBe('Jason');
    expect(person?.names).toContain('cigalefourmi');
  });

  it('resolves "me"/"I"/"myself" to the person talking', () => {
    const { message } = createFakeMessage({ authorId: '222222222222222222', authorDisplayName: 'Jason' });
    for (const self of ['me', 'I', 'Myself']) {
      expect(resolvePerson(store, self, message)?.userId).toBe('222222222222222222');
    }
    // Without a message there is no speaker to resolve to.
    expect(resolvePerson(store, 'me')).toBeUndefined();
  });

  it('resolves "me" in a relayed message to its real author', () => {
    recordRelay({ messageId: 'relay-1', channelId: 'c', authorId: '333333333333333333', authorName: 'Simon', kind: 'regret' });
    const { message } = createFakeMessage({ messageId: 'relay-1', webhookId: 'wh', authorUsername: 'Simon' });
    expect(resolvePerson(store, 'me', message)?.displayName).toBe('Simon');
  });

  it('resolves a user @-mentioned in the triggering message, using their live display name', () => {
    const { message } = createFakeMessage({
      content: 'remember <@444444444444444444> hates cilantro',
      mentionedUsers: [{ id: '444444444444444444', displayName: 'NewGuy', username: 'newguy99' }],
    });
    expect(resolvePerson(store, 'NewGuy', message)).toEqual({
      userId: '444444444444444444',
      displayName: 'NewGuy',
      names: ['NewGuy'],
    });
    expect(resolvePerson(store, '@newguy99', message)?.userId).toBe('444444444444444444');
  });

  it('never resolves to the bot itself', () => {
    const { message } = createFakeMessage({
      botUserId: '999999999999999999',
      mentionedUsers: [{ id: '999999999999999999', displayName: 'Frigidaire' }],
    });
    expect(resolvePerson(store, 'Frigidaire', message)).toBeUndefined();
    expect(resolvePerson(store, '<@999999999999999999>', message)).toBeUndefined();
  });

  it('resolves explicit ids: mention tokens, (id:…) suffixes and bare snowflakes', () => {
    expect(resolvePerson(store, '<@!111111111111111111>')?.displayName).toBe('Wheezer');
    expect(resolvePerson(store, 'Jay (id:222222222222222222)')?.displayName).toBe('Jason');
    expect(resolvePerson(store, '333333333333333333')?.displayName).toBe('Simon');
    // An id nobody knows falls back to the name.
    expect(resolvePerson(store, 'Wheezer (id:555555555555555555)')?.userId).toBe('111111111111111111');
  });

  it('leaves the server, the bot and unknown subjects unresolved', () => {
    for (const subject of ['server', 'Server', 'bot', 'general', 'pizza', '']) {
      expect(resolvePerson(store, subject)).toBeUndefined();
    }
  });
});

describe('findPeopleInText', () => {
  it('finds members by mention token, display name, handle, IRL name and nickname, most referenced first', () => {
    const refs = findPeopleInText(
      store,
      'did <@333333333333333333> see what cigalefourmi posted? Jason is unhinged. Derrick and wheez agree, lol Jason',
    );
    expect(refs.map((r) => [r.displayName, r.count])).toEqual([
      ['Jason', 3],
      ['Wheezer', 2],
      ['Simon', 1],
    ]);
    expect(refs[0].identity.username).toBe('cigalefourmi');
    expect(refs[1].names).toContain('Derrick');
  });

  it('matches whole words only, case-insensitively, next to punctuation', () => {
    const names = (text: string) => findPeopleInText(store, text).map((r) => r.displayName);
    expect(names("wheezer's car")).toEqual(['Wheezer']);
    expect(names('(@JASON)')).toEqual(['Jason']);
    expect(names('wheezers jasonic simonsays')).toEqual([]);
  });

  it('skips shared names, one-letter nicknames, links and emoji names instead of guessing', () => {
    const text = 'Alex said :D at https://x.com/cigalefourmi/status/1 <:jason:123456789012345678>';
    expect(findPeopleInText(store, text)).toEqual([]);
  });

  it('ignores mention tokens of unknown users and inactive identities', () => {
    expect(findPeopleInText(store, 'hi <@444444444444444444>')).toEqual([]);
  });

  it('builds a reusable matcher, also when nobody is known', () => {
    const match = createPeopleMatcher(store.getAllIdentities());
    expect([...match('Simon and Jason').keys()]).toEqual(['333333333333333333', '222222222222222222']);
    expect(createPeopleMatcher([])('Jason <@1>').size).toBe(0);
  });
});
