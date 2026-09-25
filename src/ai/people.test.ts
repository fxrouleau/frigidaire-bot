import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordRelay } from '../relay';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { createFakeMessage } from '../test-support/fakeDiscord';
import { setMemoryStoreForTesting } from './memory';
import { type Identity, MemoryStore, nameKey } from './memory/memoryStore';
import {
  buildPeopleDirectory,
  cleanSubject,
  createPeopleMatcher,
  currentName,
  findMembersByName,
  findPeopleInText,
  foldMembers,
  lookupPerson,
  matchMemberByName,
  memoryKeyFor,
  namesOf,
  requesterOf,
  resolvePeopleRefs,
  resolvePerson,
  resolvePersonRef,
} from './people';

// Fake ids only (the repo is public).
const WHEEZER = '111111111111111111';
const JASON = '222222222222222222';
const SIMON = '333333333333333333';
const NEWGUY = '444444444444444444';
const BOT = '999999999999999999';

let store: MemoryStore;

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  store = new MemoryStore(':memory:');
  setMemoryStoreForTesting(store);
  // Wheezer was first seen as "OldNick", is called Derrick IRL and "D" by the group.
  store.upsertIdentity(WHEEZER, 'OldNick');
  store.upsertIdentity(WHEEZER, 'Wheezer', 'wheezy_d');
  store.updateIdentityMeta(WHEEZER, { irl_name: 'Derrick', aliases_add: ['D', 'Wheez'] });
  // Jason's Discord handle is "cigalefourmi" (the learner once filed memories under it).
  store.upsertIdentity(JASON, 'Jason', 'cigalefourmi');
  store.updateIdentityMeta(JASON, { irl_name: 'Alex' });
  store.upsertIdentity(SIMON, 'Simon');
  store.updateIdentityMeta(SIMON, { irl_name: 'Alex', aliases_add: ['D'] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  setBotDbForTesting(undefined);
  setMemoryStoreForTesting(undefined);
});

function identity(id: string, displayName: string, extra: Partial<Identity> = {}): Identity {
  return {
    discord_user_id: id,
    display_name: displayName,
    canonical_name: extra.canonical_name ?? displayName,
    username: extra.username ?? null,
    irl_name: extra.irl_name ?? null,
    aliases: extra.aliases ?? [],
    first_seen_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    active: extra.active ?? 1,
  };
}

describe('nameKey', () => {
  it('compares names case-, accent- and spacing-insensitively', () => {
    expect(nameKey(' Mariè ')).toBe('marie');
    expect(nameKey('Big   Mike')).toBe('big mike');
    expect(nameKey(undefined)).toBe('');
  });
});

describe('cleanSubject', () => {
  it('strips decoration copied from prompts', () => {
    expect(cleanSubject('@Wheezer')).toBe('Wheezer');
    expect(cleanSubject(`Wheezer (id:${WHEEZER})`)).toBe('Wheezer');
    expect(cleanSubject(' "Jason" ')).toBe('Jason');
    expect(cleanSubject('server')).toBe('server');
  });
});

describe('namesOf', () => {
  it('lists every name a member may be filed under, extra names first, without duplicates', () => {
    const wheezer = store.getIdentityById(WHEEZER);
    expect(namesOf(wheezer, ['Wheezer', ' '])).toEqual(['Wheezer', 'wheezy_d', 'OldNick', 'Derrick', 'D', 'Wheez']);
    expect(namesOf(undefined, ['Solo'])).toEqual(['Solo']);
  });
});

describe('findMembersByName / matchMemberByName (name tiers)', () => {
  const members = () => foldMembers(store.getAllIdentities());

  it('matches display names, Discord handles, first-seen and IRL names and aliases, case-insensitively', () => {
    expect(matchMemberByName(members(), 'wheezer')?.userId).toBe(WHEEZER);
    expect(matchMemberByName(members(), 'CigaleFourmi')?.userId).toBe(JASON);
    expect(matchMemberByName(members(), 'OLDNICK')?.userId).toBe(WHEEZER);
    expect(matchMemberByName(members(), 'derrick')?.userId).toBe(WHEEZER);
    expect(matchMemberByName(members(), 'wheez')?.userId).toBe(WHEEZER);
  });

  it('never guesses between two members sharing a name at the same strength', () => {
    expect(findMembersByName(members(), 'Alex').map((m) => m.userId)).toEqual([JASON, SIMON]); // two IRL Alexes
    expect(matchMemberByName(members(), 'Alex')).toBeUndefined();
    expect(matchMemberByName(members(), 'D')).toBeUndefined(); // shared alias
  });

  it('prefers a stronger tier: display name over nickname, display name over handle', () => {
    store.updateIdentityMeta(SIMON, { aliases_add: ['Jason'] });
    expect(matchMemberByName(members(), 'Jason')?.userId).toBe(JASON);
    store.upsertIdentity(NEWGUY, 'cigalefourmi');
    expect(matchMemberByName(members(), 'cigalefourmi')?.userId).toBe(NEWGUY);
  });

  it('counts the first word of an IRL name only when it is unique and nobody has it as a stronger name', () => {
    const felix = identity('1', 'fridge enjoyer', { irl_name: 'Felix Rouleau' });
    expect(matchMemberByName(foldMembers([felix]), 'felix')?.userId).toBe('1');
    // Someone actually called Felix: "felix" means them.
    expect(matchMemberByName(foldMembers([felix, identity('2', 'Felix')]), 'felix')?.userId).toBe('2');
    // Two members share the IRL first name: neither is matched by it (full names still work).
    const other = identity('3', 'FT', { irl_name: 'Felix Tremblay' });
    expect(matchMemberByName(foldMembers([felix, other]), 'felix')).toBeUndefined();
    expect(matchMemberByName(foldMembers([felix, other]), 'felix tremblay')?.userId).toBe('3');
  });

  it('returns nothing for unknown or empty names and skips inactive identities', () => {
    expect(matchMemberByName(members(), 'Nobody')).toBeUndefined();
    expect(matchMemberByName(members(), '  ')).toBeUndefined();
    expect(matchMemberByName(foldMembers([identity('1', 'Ghost', { active: 0 })]), 'ghost')).toBeUndefined();
  });
});

describe('resolvePerson (memory tools)', () => {
  it('resolves a name to the member, filed under their current display name with every known name', () => {
    expect(resolvePerson(store, 'Derrick')).toEqual({
      userId: WHEEZER,
      displayName: 'Wheezer',
      names: ['Wheezer', 'wheezy_d', 'OldNick', 'Derrick', 'D', 'Wheez'],
    });
  });

  it('resolves a Discord handle to the member, whose names include it', () => {
    const person = resolvePerson(store, '@cigalefourmi');
    expect(person?.userId).toBe(JASON);
    expect(person?.displayName).toBe('Jason');
    expect(person?.names).toContain('cigalefourmi');
  });

  it('resolves "me"/"I"/"myself" to the person talking', () => {
    const { message } = createFakeMessage({ authorId: JASON, authorDisplayName: 'Jason' });
    for (const self of ['me', 'I', 'Myself']) {
      expect(resolvePerson(store, self, message)?.userId).toBe(JASON);
    }
    // Without a message there is no speaker to resolve to.
    expect(resolvePerson(store, 'me')).toBeUndefined();
  });

  it('resolves "me" in a relayed message to its real author', () => {
    recordRelay({ messageId: 'relay-1', channelId: 'c', authorId: SIMON, authorName: 'Simon', kind: 'regret' });
    const { message } = createFakeMessage({ messageId: 'relay-1', webhookId: 'wh', authorUsername: 'Simon' });
    expect(resolvePerson(store, 'me', message)?.displayName).toBe('Simon');
  });

  it('resolves a user @-mentioned in the triggering message, using their live display name', () => {
    const { message } = createFakeMessage({
      content: `remember <@${NEWGUY}> hates cilantro`,
      mentionedUsers: [{ id: NEWGUY, displayName: 'NewGuy', username: 'newguy99' }],
    });
    expect(resolvePerson(store, 'NewGuy', message)).toEqual({
      userId: NEWGUY,
      displayName: 'NewGuy',
      names: ['NewGuy', 'newguy99'],
    });
    expect(resolvePerson(store, '@newguy99', message)?.userId).toBe(NEWGUY);
  });

  it('prefers a member @-mentioned in the message when a name is shared', () => {
    store.upsertIdentity(NEWGUY, 'Simon');
    const { message } = createFakeMessage({
      content: `<@${NEWGUY}> is the other Simon`,
      mentionedUsers: [{ id: NEWGUY, displayName: 'Simon' }],
    });
    expect(resolvePerson(store, 'Simon')).toBeUndefined();
    expect(resolvePerson(store, 'Simon', message)?.userId).toBe(NEWGUY);
  });

  it('never resolves to the bot itself', () => {
    const { message } = createFakeMessage({
      botUserId: BOT,
      mentionedUsers: [{ id: BOT, displayName: 'Frigidaire' }],
    });
    expect(resolvePerson(store, 'Frigidaire', message)).toBeUndefined();
    expect(resolvePerson(store, `<@${BOT}>`, message)).toBeUndefined();
  });

  it('resolves explicit ids: mention tokens, (id:…) suffixes and bare snowflakes', () => {
    expect(resolvePerson(store, `<@!${WHEEZER}>`)?.displayName).toBe('Wheezer');
    expect(resolvePerson(store, `Jay (id:${JASON})`)?.displayName).toBe('Jason');
    expect(resolvePerson(store, SIMON)?.displayName).toBe('Simon');
    // An id nobody knows falls back to the name written next to it; a bare unknown id resolves to nobody.
    expect(resolvePerson(store, 'Wheezer (id:555555555555555555)')?.userId).toBe(WHEEZER);
    expect(resolvePerson(store, '<@555555555555555555>')).toBeUndefined();
  });

  it('leaves the server, the bot, crowds and unknown subjects unresolved', () => {
    for (const subject of ['server', 'Server', 'bot', 'general', 'everyone', 'pizza', '']) {
      expect(resolvePerson(store, subject)).toBeUndefined();
    }
  });

  it('does not match partial names (a memory must not be filed under a guess)', () => {
    expect(resolvePerson(store, 'whee')).toBeUndefined();
  });
});

describe('resolvePersonRef (reminders and birthdays: fuzzy, with explanations)', () => {
  const FELIX = '100000000000000001';
  const WHEEZ = '100000000000000002';
  const JAY = '100000000000000003';
  const MARIE = '100000000000000004';

  beforeEach(() => {
    store = new MemoryStore(':memory:');
    setMemoryStoreForTesting(store);
    store.upsertIdentity(FELIX, 'fridge enjoyer');
    store.updateIdentityMeta(FELIX, { irl_name: 'Felix Rouleau', aliases_add: ['Flex'] });
    store.upsertIdentity(WHEEZ, 'Wheezer');
    store.updateIdentityMeta(WHEEZ, { irl_name: 'Jason' });
    store.upsertIdentity(JAY, 'Jaybird');
    store.upsertIdentity(MARIE, 'Mariè');
  });

  function directoryFor(opts: Parameters<typeof createFakeMessage>[0] = {}) {
    return buildPeopleDirectory(
      createFakeMessage({ authorId: FELIX, authorDisplayName: 'fridge enjoyer', ...opts }).message,
    );
  }

  function resolvedId(ref: string, dir = directoryFor()): string | undefined {
    const result = resolvePersonRef(ref, dir);
    return result.ok ? result.person.userId : undefined;
  }

  it('resolves display names, IRL names (full or first), aliases and canonical names, case-insensitively', () => {
    expect(resolvedId('wheezer')).toBe(WHEEZ);
    expect(resolvedId('@Wheezer')).toBe(WHEEZ);
    expect(resolvedId('Jason')).toBe(WHEEZ);
    expect(resolvedId('felix rouleau')).toBe(FELIX);
    expect(resolvedId('Felix')).toBe(FELIX);
    expect(resolvedId('flex')).toBe(FELIX);
  });

  it('ignores accents and surrounding quotes', () => {
    expect(resolvedId('Marie')).toBe(MARIE);
    expect(resolvedId('"Mariè"')).toBe(MARIE);
  });

  it('resolves mention tokens and raw ids of known people', () => {
    expect(resolvedId(`<@${WHEEZ}>`)).toBe(WHEEZ);
    expect(resolvedId(`<@!${WHEEZ}>`)).toBe(WHEEZ);
    expect(resolvedId(JAY)).toBe(JAY);
  });

  it('rejects an id nobody knows', () => {
    expect(resolvePersonRef('<@999999999999999998>', directoryFor())).toEqual({
      ok: false,
      error: "I don't know anyone with id 999999999999999998 in this server.",
    });
  });

  it('maps "me" to the requester', () => {
    expect(resolvedId('me')).toBe(FELIX);
    expect(resolvedId('Myself')).toBe(FELIX);
  });

  it('refuses crowds and the bot', () => {
    const crowd = resolvePersonRef('@everyone', directoryFor());
    expect(crowd.ok).toBe(false);
    if (!crowd.ok) expect(crowd.error).toContain('specific people');
    const bot = resolvePersonRef('Frigidaire', directoryFor({ mentionedUsers: [{ id: 'bot-1', displayName: 'Frigidaire' }] }));
    expect(bot.ok).toBe(false);
  });

  it('falls back to a word inside a longer name, then a unique prefix of 3+ characters', () => {
    store.upsertIdentity('100000000000000006', 'big gamer');
    expect(resolvedId('gamer')).toBe('100000000000000006');
    expect(resolvedId('whee')).toBe(WHEEZ);
    expect(resolvedId('jas')).toBe(WHEEZ); // only Wheezer's IRL name starts with "jas"
    // Two letters are too short for a prefix match, and match no whole name or word.
    expect(resolvedId('ja')).toBeUndefined();
  });

  it('reports ambiguity with ids instead of guessing', () => {
    store.upsertIdentity('100000000000000005', 'Jaylen');
    const twoJays = resolvePersonRef('jay', directoryFor());
    expect(twoJays.ok).toBe(false);
    if (!twoJays.ok) {
      expect(twoJays.error).toContain(`Jaybird (id:${JAY})`);
      expect(twoJays.error).toContain('Jaylen (id:100000000000000005)');
    }
  });

  it('lists the people it knows when nothing matches', () => {
    const result = resolvePersonRef('Gandalf', directoryFor());
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

  it('resolvePeopleRefs deduplicates people named twice and stops at the first unknown', () => {
    const dir = directoryFor();
    const resolved = resolvePeopleRefs(['Wheezer', 'jason', 'me'], dir);
    expect(resolved.ok && resolved.people.map((p) => [p.userId, p.displayName])).toEqual([
      [WHEEZ, 'Wheezer'],
      [FELIX, 'fridge enjoyer'],
    ]);
    expect(resolvePeopleRefs(['Wheezer', 'Gandalf'], dir).ok).toBe(false);
  });
});

describe('requesterOf / currentName', () => {
  it('attributes a relayed webhook message to the member it was posted for', () => {
    recordRelay({ messageId: 'relay-1', channelId: 'channel-1', authorId: JASON, authorName: 'Jason', kind: 'link_fix' });
    const relayed = createFakeMessage({ messageId: 'relay-1', webhookId: 'hook-1', authorId: 'hook-1' }).message;
    expect(requesterOf(relayed)).toMatchObject({ userId: JASON, displayName: 'Jason' });
  });

  it('uses the author of a regular message', () => {
    const message = createFakeMessage({ authorId: SIMON, authorDisplayName: 'Simon' }).message;
    expect(requesterOf(message)).toMatchObject({ userId: SIMON, displayName: 'Simon' });
  });

  it('prefers the identity display name and falls back otherwise', () => {
    expect(currentName(WHEEZER, 'old name')).toBe('Wheezer');
    expect(currentName('unknown', 'fallback')).toBe('fallback');
  });
});

describe('linked side accounts (LINKED_ACCOUNTS)', () => {
  const TONY = '120000000000000001';
  const TONY_SIDE = '120000000000000002';

  beforeEach(() => {
    vi.stubEnv('LINKED_ACCOUNTS', `${TONY_SIDE}:${TONY}`);
    store.upsertIdentity(TONY, 'Tony', 'tony_main');
    store.upsertIdentity(TONY_SIDE, 'Ptoughneigh', 'triceclone');
  });

  it('folds a side account into its main account as one member', () => {
    const members = foldMembers(store.getAllIdentities());
    const tony = members.filter((m) => m.userId === TONY);
    expect(tony).toHaveLength(1);
    expect(tony[0].displayName).toBe('Tony');
    expect(tony[0].sideAccounts.map((i) => i.discord_user_id)).toEqual([TONY_SIDE]);
    expect(tony[0].names).toEqual(['Tony', 'tony_main', 'Ptoughneigh', 'triceclone']);
    expect(members.some((m) => m.userId === TONY_SIDE)).toBe(false);
  });

  it("resolves the side account's names, mention and id to the main account", () => {
    for (const ref of ['Ptoughneigh', '@triceclone', `<@${TONY_SIDE}>`, TONY_SIDE, 'tony']) {
      expect(resolvePerson(store, ref)?.userId).toBe(TONY);
    }
    expect(resolvePerson(store, 'triceclone')?.displayName).toBe('Tony');
  });

  it('treats a name both accounts share as one person, not an ambiguity', () => {
    store.upsertIdentity(TONY_SIDE, 'Tony', 'triceclone');
    expect(resolvePerson(store, 'Tony')?.userId).toBe(TONY);
  });

  it('resolves "me" from the side account to the main account', () => {
    const { message } = createFakeMessage({ authorId: TONY_SIDE, authorDisplayName: 'Ptoughneigh' });
    expect(resolvePerson(store, 'me', message)).toMatchObject({ userId: TONY, displayName: 'Tony' });
    expect(requesterOf(message).userId).toBe(TONY);
  });

  it('labels a member known only by a side account under the main id', () => {
    store = new MemoryStore(':memory:');
    setMemoryStoreForTesting(store);
    store.upsertIdentity(TONY_SIDE, 'Ptoughneigh', 'triceclone');
    expect(resolvePerson(store, 'Ptoughneigh')).toMatchObject({ userId: TONY, displayName: 'Ptoughneigh' });
  });

  it('memoryKeyFor: the main id and every name of every account, from either id', () => {
    const expected = { userId: TONY, names: ['Tony (live)', 'Tony', 'tony_main', 'Ptoughneigh', 'triceclone'] };
    expect(memoryKeyFor(store, TONY, ['Tony (live)'])).toEqual(expected);
    expect(memoryKeyFor(store, TONY_SIDE, ['Tony (live)'])).toEqual(expected);
  });

  it("finds the member in text by the side account's names or mention, counted once per reference", () => {
    const refs = findPeopleInText(store, `ptoughneigh said <@${TONY_SIDE}> and tony are the same guy`);
    expect(refs.map((r) => [r.userId, r.count])).toEqual([[TONY, 3]]);
  });

  it('currentName of a side account id is the main account name', () => {
    expect(currentName(TONY_SIDE, 'fallback')).toBe('Tony');
  });
});

describe('memoryKeyFor', () => {
  it('collects every name, including the Discord handle, for someone without linked accounts', () => {
    expect(memoryKeyFor(store, JASON, ['Jason (live)', '  ', undefined])).toEqual({
      userId: JASON,
      names: ['Jason (live)', 'Jason', 'cigalefourmi', 'Alex'],
    });
  });

  it('works for someone the bot has no identity for', () => {
    expect(memoryKeyFor(store, NEWGUY, ['newguy', 'newguy', null])).toEqual({ userId: NEWGUY, names: ['newguy'] });
  });
});

describe('findPeopleInText', () => {
  it('finds members by mention token, display name, handle, IRL name and nickname, most referenced first', () => {
    const refs = findPeopleInText(
      store,
      `did <@${SIMON}> see what cigalefourmi posted? Jason is unhinged. Derrick and wheez agree, lol Jason`,
    );
    expect(refs.map((r) => [r.displayName, r.count])).toEqual([
      ['Jason', 3],
      ['Wheezer', 2],
      ['Simon', 1],
    ]);
    expect(refs[0].member.identity?.username).toBe('cigalefourmi');
    expect(refs[1].names).toContain('Derrick');
  });

  it('matches whole words only, case- and accent-insensitively, next to punctuation', () => {
    const names = (text: string) => findPeopleInText(store, text).map((r) => r.displayName);
    expect(names("wheezer's car")).toEqual(['Wheezer']);
    expect(names('(@JASON)')).toEqual(['Jason']);
    expect(names('WHEEZÉR?')).toEqual(['Wheezer']);
    expect(names('wheezers jasonic simonsays')).toEqual([]);
  });

  it('matches multi-word names across any whitespace, the longer name winning', () => {
    store.upsertIdentity('500000000000000001', 'Big Mike');
    store.upsertIdentity('500000000000000002', 'Mike');
    const refs = findPeopleInText(store, 'is big   mike coming? mike is');
    expect(refs.map((r) => [r.displayName, r.count])).toEqual([
      ['Big Mike', 1],
      ['Mike', 1],
    ]);
  });

  it('skips shared names, short nicknames, links, emoji and role/channel tokens instead of guessing', () => {
    const text = 'Alex said :D at https://x.com/cigalefourmi/status/1 <:jason:123456789012345678> <#123456789012345678>';
    expect(findPeopleInText(store, text)).toEqual([]);
  });

  it('never matches names under three letters, except IRL names down to two', () => {
    store.upsertIdentity('500000000000000003', 'Ed');
    store.upsertIdentity('500000000000000004', 'kizanz');
    store.updateIdentityMeta('500000000000000004', { irl_name: 'Yi' });
    const names = (text: string) => findPeopleInText(store, text).map((r) => r.displayName);
    expect(names('ed is here')).toEqual([]);
    expect(names('yi is here')).toEqual(['kizanz']);
  });

  it('matches an IRL first name only when it is unambiguous', () => {
    store.upsertIdentity('500000000000000005', 'xX_Jay_Xx');
    store.updateIdentityMeta('500000000000000005', { irl_name: 'Jay Smith' });
    const ids = (text: string) => findPeopleInText(store, text).map((r) => r.userId);
    expect(ids('did jay ever pay you back')).toEqual(['500000000000000005']);
    store.upsertIdentity('500000000000000006', 'JT');
    store.updateIdentityMeta('500000000000000006', { irl_name: 'Jay Tran' });
    expect(ids('did jay ever pay you back')).toEqual([]);
    expect(ids('jay tran?')).toEqual(['500000000000000006']);
  });

  it('never matches stop words or the excluded (bot) names, and drops excluded people', () => {
    store.upsertIdentity('500000000000000007', 'The');
    store.upsertIdentity('500000000000000008', 'Frigidaire Fan');
    store.updateIdentityMeta('500000000000000008', { aliases_add: ['Frigidaire'] });
    expect(findPeopleInText(store, 'the fridge')).toEqual([]);
    expect(findPeopleInText(store, 'frigidaire what do you think', { excludeNames: ['Frigidaire'] })).toEqual([]);
    expect(findPeopleInText(store, 'jason and wheezer', { excludeUserIds: [JASON] }).map((r) => r.userId)).toEqual([
      WHEEZER,
    ]);
  });

  it('ignores mention tokens of unknown users', () => {
    expect(findPeopleInText(store, `hi <@${NEWGUY}>`)).toEqual([]);
  });

  it('builds a reusable matcher whose order is the order people come up in', () => {
    const match = createPeopleMatcher(store.getAllIdentities());
    expect([...match(`Simon and Jason and <@${WHEEZER}>`).keys()]).toEqual([SIMON, JASON, WHEEZER]);
    expect([...match(`<@${WHEEZER}> then Simon`).keys()]).toEqual([WHEEZER, SIMON]);
    expect(createPeopleMatcher([])('Jason <@1>').size).toBe(0);
  });
});

describe('lookupPerson', () => {
  it('explains why a reference did not resolve', () => {
    const dir = buildPeopleDirectory(undefined, store);
    expect(lookupPerson(dir, '')).toEqual({ ok: false, reason: 'empty' });
    expect(lookupPerson(dir, 'me')).toEqual({ ok: false, reason: 'no-requester' });
    expect(lookupPerson(dir, 'here')).toEqual({ ok: false, reason: 'crowd' });
    expect(lookupPerson(dir, '<@555555555555555555>')).toEqual({ ok: false, reason: 'unknown-id', id: '555555555555555555' });
    expect(lookupPerson(dir, 'D')).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(lookupPerson(dir, 'nobody')).toEqual({ ok: false, reason: 'unknown' });
  });
});
