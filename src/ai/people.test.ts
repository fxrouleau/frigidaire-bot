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
const WHEELIE = '111111111111111111';
const JASPER = '222222222222222222';
const SILAS = '333333333333333333';
const NEWGUY = '444444444444444444';
const BOT = '999999999999999999';

let store: MemoryStore;

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  store = new MemoryStore(':memory:');
  setMemoryStoreForTesting(store);
  // Wheelie was first seen as "OldNick", is called Dorian IRL and "D" by the group.
  store.upsertIdentity(WHEELIE, 'OldNick');
  store.upsertIdentity(WHEELIE, 'Wheelie', 'wheelie_d');
  store.updateIdentityMeta(WHEELIE, { irl_name: 'Dorian', aliases_add: ['D', 'Wheels'] });
  // Jasper's Discord handle is "lapinlune" (the learner once filed memories under it).
  store.upsertIdentity(JASPER, 'Jasper', 'lapinlune');
  store.updateIdentityMeta(JASPER, { irl_name: 'Alex' });
  store.upsertIdentity(SILAS, 'Silas');
  store.updateIdentityMeta(SILAS, { irl_name: 'Alex', aliases_add: ['D'] });
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
    expect(cleanSubject('@Wheelie')).toBe('Wheelie');
    expect(cleanSubject(`Wheelie (id:${WHEELIE})`)).toBe('Wheelie');
    expect(cleanSubject(' "Jasper" ')).toBe('Jasper');
    expect(cleanSubject('server')).toBe('server');
  });
});

describe('namesOf', () => {
  it('lists every name a member may be filed under, extra names first, without duplicates', () => {
    const wheelie = store.getIdentityById(WHEELIE);
    expect(namesOf(wheelie, ['Wheelie', ' '])).toEqual(['Wheelie', 'wheelie_d', 'OldNick', 'Dorian', 'D', 'Wheels']);
    expect(namesOf(undefined, ['Solo'])).toEqual(['Solo']);
  });
});

describe('findMembersByName / matchMemberByName (name tiers)', () => {
  const members = () => foldMembers(store.getAllIdentities());

  it('matches display names, Discord handles, first-seen and IRL names and aliases, case-insensitively', () => {
    expect(matchMemberByName(members(), 'wheelie')?.userId).toBe(WHEELIE);
    expect(matchMemberByName(members(), 'LapinLune')?.userId).toBe(JASPER);
    expect(matchMemberByName(members(), 'OLDNICK')?.userId).toBe(WHEELIE);
    expect(matchMemberByName(members(), 'dorian')?.userId).toBe(WHEELIE);
    expect(matchMemberByName(members(), 'wheels')?.userId).toBe(WHEELIE);
  });

  it('never guesses between two members sharing a name at the same strength', () => {
    expect(findMembersByName(members(), 'Alex').map((m) => m.userId)).toEqual([JASPER, SILAS]); // two IRL Alexes
    expect(matchMemberByName(members(), 'Alex')).toBeUndefined();
    expect(matchMemberByName(members(), 'D')).toBeUndefined(); // shared alias
  });

  it('prefers a stronger tier: display name over nickname, display name over handle', () => {
    store.updateIdentityMeta(SILAS, { aliases_add: ['Jasper'] });
    expect(matchMemberByName(members(), 'Jasper')?.userId).toBe(JASPER);
    store.upsertIdentity(NEWGUY, 'lapinlune');
    expect(matchMemberByName(members(), 'lapinlune')?.userId).toBe(NEWGUY);
  });

  it('counts the first word of an IRL name only when it is unique and nobody has it as a stronger name', () => {
    const remi = identity('1', 'fridge enjoyer', { irl_name: 'Remi Lachance' });
    expect(matchMemberByName(foldMembers([remi]), 'remi')?.userId).toBe('1');
    // Someone actually called Remi: "remi" means them.
    expect(matchMemberByName(foldMembers([remi, identity('2', 'Remi')]), 'remi')?.userId).toBe('2');
    // Two members share the IRL first name: neither is matched by it (full names still work).
    const other = identity('3', 'FT', { irl_name: 'Remi Tremblay' });
    expect(matchMemberByName(foldMembers([remi, other]), 'remi')).toBeUndefined();
    expect(matchMemberByName(foldMembers([remi, other]), 'remi tremblay')?.userId).toBe('3');
  });

  it('returns nothing for unknown or empty names and skips inactive identities', () => {
    expect(matchMemberByName(members(), 'Nobody')).toBeUndefined();
    expect(matchMemberByName(members(), '  ')).toBeUndefined();
    expect(matchMemberByName(foldMembers([identity('1', 'Ghost', { active: 0 })]), 'ghost')).toBeUndefined();
  });
});

describe('resolvePerson (memory tools)', () => {
  it('resolves a name to the member, filed under their current display name with every known name', () => {
    expect(resolvePerson(store, 'Dorian')).toEqual({
      userId: WHEELIE,
      displayName: 'Wheelie',
      names: ['Wheelie', 'wheelie_d', 'OldNick', 'Dorian', 'D', 'Wheels'],
    });
  });

  it('resolves a Discord handle to the member, whose names include it', () => {
    const person = resolvePerson(store, '@lapinlune');
    expect(person?.userId).toBe(JASPER);
    expect(person?.displayName).toBe('Jasper');
    expect(person?.names).toContain('lapinlune');
  });

  it('resolves "me"/"I"/"myself" to the person talking', () => {
    const { message } = createFakeMessage({ authorId: JASPER, authorDisplayName: 'Jasper' });
    for (const self of ['me', 'I', 'Myself']) {
      expect(resolvePerson(store, self, message)?.userId).toBe(JASPER);
    }
    // Without a message there is no speaker to resolve to.
    expect(resolvePerson(store, 'me')).toBeUndefined();
  });

  it('resolves "me" in a relayed message to its real author', () => {
    recordRelay({ messageId: 'relay-1', channelId: 'c', authorId: SILAS, authorName: 'Silas', kind: 'regret' });
    const { message } = createFakeMessage({ messageId: 'relay-1', webhookId: 'wh', authorUsername: 'Silas' });
    expect(resolvePerson(store, 'me', message)?.displayName).toBe('Silas');
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
    store.upsertIdentity(NEWGUY, 'Silas');
    const { message } = createFakeMessage({
      content: `<@${NEWGUY}> is the other Silas`,
      mentionedUsers: [{ id: NEWGUY, displayName: 'Silas' }],
    });
    expect(resolvePerson(store, 'Silas')).toBeUndefined();
    expect(resolvePerson(store, 'Silas', message)?.userId).toBe(NEWGUY);
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
    expect(resolvePerson(store, `<@!${WHEELIE}>`)?.displayName).toBe('Wheelie');
    expect(resolvePerson(store, `Jay (id:${JASPER})`)?.displayName).toBe('Jasper');
    expect(resolvePerson(store, SILAS)?.displayName).toBe('Silas');
    // An id nobody knows falls back to the name written next to it; a bare unknown id resolves to nobody.
    expect(resolvePerson(store, 'Wheelie (id:555555555555555555)')?.userId).toBe(WHEELIE);
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
  const REMI = '100000000000000001';
  const WHEELS = '100000000000000002';
  const JAY = '100000000000000003';
  const MARIE = '100000000000000004';

  beforeEach(() => {
    store = new MemoryStore(':memory:');
    setMemoryStoreForTesting(store);
    store.upsertIdentity(REMI, 'fridge enjoyer');
    store.updateIdentityMeta(REMI, { irl_name: 'Remi Lachance', aliases_add: ['Flex'] });
    store.upsertIdentity(WHEELS, 'Wheelie');
    store.updateIdentityMeta(WHEELS, { irl_name: 'Jasper' });
    store.upsertIdentity(JAY, 'Jaybird');
    store.upsertIdentity(MARIE, 'Mariè');
  });

  function directoryFor(opts: Parameters<typeof createFakeMessage>[0] = {}) {
    return buildPeopleDirectory(
      createFakeMessage({ authorId: REMI, authorDisplayName: 'fridge enjoyer', ...opts }).message,
    );
  }

  function resolvedId(ref: string, dir = directoryFor()): string | undefined {
    const result = resolvePersonRef(ref, dir);
    return result.ok ? result.person.userId : undefined;
  }

  it('resolves display names, IRL names (full or first), aliases and canonical names, case-insensitively', () => {
    expect(resolvedId('wheelie')).toBe(WHEELS);
    expect(resolvedId('@Wheelie')).toBe(WHEELS);
    expect(resolvedId('Jasper')).toBe(WHEELS);
    expect(resolvedId('remi lachance')).toBe(REMI);
    expect(resolvedId('Remi')).toBe(REMI);
    expect(resolvedId('flex')).toBe(REMI);
  });

  it('ignores accents and surrounding quotes', () => {
    expect(resolvedId('Marie')).toBe(MARIE);
    expect(resolvedId('"Mariè"')).toBe(MARIE);
  });

  it('resolves mention tokens and raw ids of known people', () => {
    expect(resolvedId(`<@${WHEELS}>`)).toBe(WHEELS);
    expect(resolvedId(`<@!${WHEELS}>`)).toBe(WHEELS);
    expect(resolvedId(JAY)).toBe(JAY);
  });

  it('rejects an id nobody knows', () => {
    expect(resolvePersonRef('<@999999999999999998>', directoryFor())).toEqual({
      ok: false,
      error: "I don't know anyone with id 999999999999999998 in this server.",
    });
  });

  it('maps "me" to the requester', () => {
    expect(resolvedId('me')).toBe(REMI);
    expect(resolvedId('Myself')).toBe(REMI);
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
    expect(resolvedId('whee')).toBe(WHEELS);
    expect(resolvedId('jas')).toBe(WHEELS); // only Wheelie's IRL name starts with "jas"
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
      expect(result.error).toContain('Wheelie');
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
    const resolved = resolvePeopleRefs(['Wheelie', 'jasper', 'me'], dir);
    expect(resolved.ok && resolved.people.map((p) => [p.userId, p.displayName])).toEqual([
      [WHEELS, 'Wheelie'],
      [REMI, 'fridge enjoyer'],
    ]);
    expect(resolvePeopleRefs(['Wheelie', 'Gandalf'], dir).ok).toBe(false);
  });
});

describe('requesterOf / currentName', () => {
  it('attributes a relayed webhook message to the member it was posted for', () => {
    recordRelay({ messageId: 'relay-1', channelId: 'channel-1', authorId: JASPER, authorName: 'Jasper', kind: 'link_fix' });
    const relayed = createFakeMessage({ messageId: 'relay-1', webhookId: 'hook-1', authorId: 'hook-1' }).message;
    expect(requesterOf(relayed)).toMatchObject({ userId: JASPER, displayName: 'Jasper' });
  });

  it('uses the author of a regular message', () => {
    const message = createFakeMessage({ authorId: SILAS, authorDisplayName: 'Silas' }).message;
    expect(requesterOf(message)).toMatchObject({ userId: SILAS, displayName: 'Silas' });
  });

  it('prefers the identity display name and falls back otherwise', () => {
    expect(currentName(WHEELIE, 'old name')).toBe('Wheelie');
    expect(currentName('unknown', 'fallback')).toBe('fallback');
  });
});

describe('linked side accounts (LINKED_ACCOUNTS)', () => {
  const TOBY = '120000000000000001';
  const TOBY_SIDE = '120000000000000002';

  beforeEach(() => {
    vi.stubEnv('LINKED_ACCOUNTS', `${TOBY_SIDE}:${TOBY}`);
    store.upsertIdentity(TOBY, 'Toby', 'toby_main');
    store.upsertIdentity(TOBY_SIDE, 'Tohbee', 'tobyclone');
  });

  it('folds a side account into its main account as one member', () => {
    const members = foldMembers(store.getAllIdentities());
    const toby = members.filter((m) => m.userId === TOBY);
    expect(toby).toHaveLength(1);
    expect(toby[0].displayName).toBe('Toby');
    expect(toby[0].sideAccounts.map((i) => i.discord_user_id)).toEqual([TOBY_SIDE]);
    expect(toby[0].names).toEqual(['Toby', 'toby_main', 'Tohbee', 'tobyclone']);
    expect(members.some((m) => m.userId === TOBY_SIDE)).toBe(false);
  });

  it("resolves the side account's names, mention and id to the main account", () => {
    for (const ref of ['Tohbee', '@tobyclone', `<@${TOBY_SIDE}>`, TOBY_SIDE, 'toby']) {
      expect(resolvePerson(store, ref)?.userId).toBe(TOBY);
    }
    expect(resolvePerson(store, 'tobyclone')?.displayName).toBe('Toby');
  });

  it('treats a name both accounts share as one person, not an ambiguity', () => {
    store.upsertIdentity(TOBY_SIDE, 'Toby', 'tobyclone');
    expect(resolvePerson(store, 'Toby')?.userId).toBe(TOBY);
  });

  it('resolves "me" from the side account to the main account', () => {
    const { message } = createFakeMessage({ authorId: TOBY_SIDE, authorDisplayName: 'Tohbee' });
    expect(resolvePerson(store, 'me', message)).toMatchObject({ userId: TOBY, displayName: 'Toby' });
    expect(requesterOf(message).userId).toBe(TOBY);
  });

  it('labels a member known only by a side account under the main id', () => {
    store = new MemoryStore(':memory:');
    setMemoryStoreForTesting(store);
    store.upsertIdentity(TOBY_SIDE, 'Tohbee', 'tobyclone');
    expect(resolvePerson(store, 'Tohbee')).toMatchObject({ userId: TOBY, displayName: 'Tohbee' });
  });

  it('memoryKeyFor: the main id and every name of every account, from either id', () => {
    const expected = { userId: TOBY, names: ['Toby (live)', 'Toby', 'toby_main', 'Tohbee', 'tobyclone'] };
    expect(memoryKeyFor(store, TOBY, ['Toby (live)'])).toEqual(expected);
    expect(memoryKeyFor(store, TOBY_SIDE, ['Toby (live)'])).toEqual(expected);
  });

  it("finds the member in text by the side account's names or mention, counted once per reference", () => {
    const refs = findPeopleInText(store, `tohbee said <@${TOBY_SIDE}> and toby are the same guy`);
    expect(refs.map((r) => [r.userId, r.count])).toEqual([[TOBY, 3]]);
  });

  it('currentName of a side account id is the main account name', () => {
    expect(currentName(TOBY_SIDE, 'fallback')).toBe('Toby');
  });
});

describe('memoryKeyFor', () => {
  it('collects every name, including the Discord handle, for someone without linked accounts', () => {
    expect(memoryKeyFor(store, JASPER, ['Jasper (live)', '  ', undefined])).toEqual({
      userId: JASPER,
      names: ['Jasper (live)', 'Jasper', 'lapinlune', 'Alex'],
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
      `did <@${SILAS}> see what lapinlune posted? Jasper is unhinged. Dorian and wheels agree, lol Jasper`,
    );
    expect(refs.map((r) => [r.displayName, r.count])).toEqual([
      ['Jasper', 3],
      ['Wheelie', 2],
      ['Silas', 1],
    ]);
    expect(refs[0].member.identity?.username).toBe('lapinlune');
    expect(refs[1].names).toContain('Dorian');
  });

  it('matches whole words only, case- and accent-insensitively, next to punctuation', () => {
    const names = (text: string) => findPeopleInText(store, text).map((r) => r.displayName);
    expect(names("wheelie's car")).toEqual(['Wheelie']);
    expect(names('(@JASPER)')).toEqual(['Jasper']);
    expect(names('WHEELIÉ?')).toEqual(['Wheelie']);
    expect(names('wheelies jasperic silassays')).toEqual([]);
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
    const text = 'Alex said :D at https://x.com/lapinlune/status/1 <:jasper:123456789012345678> <#123456789012345678>';
    expect(findPeopleInText(store, text)).toEqual([]);
  });

  it('never matches names under three letters, except IRL names down to two', () => {
    store.upsertIdentity('500000000000000003', 'Ed');
    store.upsertIdentity('500000000000000004', 'zorbix');
    store.updateIdentityMeta('500000000000000004', { irl_name: 'Yu' });
    const names = (text: string) => findPeopleInText(store, text).map((r) => r.displayName);
    expect(names('ed is here')).toEqual([]);
    expect(names('yu is here')).toEqual(['zorbix']);
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
    expect(findPeopleInText(store, 'jasper and wheelie', { excludeUserIds: [JASPER] }).map((r) => r.userId)).toEqual([
      WHEELIE,
    ]);
  });

  it('ignores mention tokens of unknown users', () => {
    expect(findPeopleInText(store, `hi <@${NEWGUY}>`)).toEqual([]);
  });

  it('builds a reusable matcher whose order is the order people come up in', () => {
    const match = createPeopleMatcher(store.getAllIdentities());
    expect([...match(`Silas and Jasper and <@${WHEELIE}>`).keys()]).toEqual([SILAS, JASPER, WHEELIE]);
    expect([...match(`<@${WHEELIE}> then Silas`).keys()]).toEqual([WHEELIE, SILAS]);
    expect(createPeopleMatcher([])('Jasper <@1>').size).toBe(0);
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
