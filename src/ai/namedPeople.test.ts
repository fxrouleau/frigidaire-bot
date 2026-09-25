import { describe, expect, it } from 'vitest';
import type { Identity } from './memory/memoryStore';
import { findNamedPeople, identityNames } from './namedPeople';

function identity(id: string, displayName: string, extra: Partial<Identity> & { username?: string } = {}): Identity {
  return {
    discord_user_id: id,
    display_name: displayName,
    canonical_name: extra.canonical_name ?? displayName,
    irl_name: extra.irl_name ?? null,
    aliases: extra.aliases ?? [],
    first_seen_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    active: extra.active ?? 1,
    ...(extra.username !== undefined ? { username: extra.username } : {}),
  };
}

const JASON = identity('1', 'xX_Jay_Xx', { canonical_name: 'jayboy', irl_name: 'Jason Smith', aliases: ['J-Dog'] });
const WHEEZER = identity('2', 'Wheezer', { aliases: ['wheez'] });
const MIKE = identity('3', 'Big Mike');
const ED = identity('4', 'Ed');

describe('identityNames', () => {
  it('lists every name once: display, canonical, IRL (and its first word), aliases', () => {
    expect(identityNames(JASON)).toEqual(['xX_Jay_Xx', 'jayboy', 'Jason Smith', 'Jason', 'J-Dog']);
  });

  it('includes username when the identities row carries one', () => {
    expect(identityNames(identity('5', 'Nick', { username: 'nick_the_stick' }))).toContain('nick_the_stick');
  });

  it('dedupes names case-insensitively', () => {
    expect(identityNames(identity('6', 'Wheezer', { canonical_name: 'wheezer', aliases: ['WHEEZER'] }))).toEqual([
      'Wheezer',
    ]);
  });
});

describe('findNamedPeople', () => {
  const all = [JASON, WHEEZER, MIKE, ED];
  const ids = (text: string, opts = {}) => findNamedPeople(text, all, opts).map((p) => p.identity.discord_user_id);

  it('matches any known name, case-insensitively, as a whole word', () => {
    expect(ids('did jason ever pay you back')).toEqual(['1']);
    expect(ids("WHEEZ's setup is cursed")).toEqual(['2']);
    expect(ids('ask j-dog')).toEqual(['1']);
    expect(ids('wheezers')).toEqual([]);
    expect(ids('jasonic')).toEqual([]);
  });

  it('matches multi-word names across any whitespace', () => {
    expect(ids('is big   mike coming')).toEqual(['3']);
  });

  it('orders people by first appearance and caps the count', () => {
    expect(ids('wheezer and jason and big mike')).toEqual(['2', '1', '3']);
    expect(ids('wheezer and jason and big mike', { max: 2 })).toEqual(['2', '1']);
  });

  it('ignores names shorter than 3 characters and stop words', () => {
    expect(ids('ed is here')).toEqual([]);
    const theGuy = identity('7', 'The');
    expect(findNamedPeople('the fridge', [theGuy])).toEqual([]);
  });

  it('never matches excluded people or the bot names', () => {
    expect(ids('jason and wheezer', { excludeUserIds: ['1'] })).toEqual(['2']);
    const fridgeFan = identity('8', 'Frigidaire Fan', { aliases: ['Frigidaire'] });
    expect(findNamedPeople('frigidaire what do you think', [fridgeFan], { excludeNames: ['Frigidaire'] })).toEqual([]);
  });

  it('ignores names inside mentions, custom emojis and URLs', () => {
    expect(ids('<:wheezer:123456> lol')).toEqual([]);
    expect(ids('look https://example.com/jason/post')).toEqual([]);
  });

  it('skips inactive identities', () => {
    expect(findNamedPeople('wheezer?', [identity('2', 'Wheezer', { active: 0 })])).toEqual([]);
  });

  it('prefers the longer name when two names of one person match at the same spot', () => {
    const [match] = findNamedPeople('jason smith called', [JASON]);
    expect(match.name).toBe('Jason Smith');
  });
});
