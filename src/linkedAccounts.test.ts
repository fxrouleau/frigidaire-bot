import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLinkedAccounts } from './config';
import { accountIdsFor, canonicalUserId, isSamePerson } from './linkedAccounts';

const MAIN = '100000000000000001';
const SIDE = '100000000000000002';
const OTHER = '100000000000000003';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseLinkedAccounts', () => {
  it('parses side:main pairs and drops malformed entries and self-links', () => {
    const links = parseLinkedAccounts([`${SIDE}:${MAIN}`, 'nope', `${OTHER}:${OTHER}`, `${SIDE}:`, 'a:b', `1:2:3`]);
    expect([...links]).toEqual([[SIDE, MAIN]]);
  });
});

describe('linked account resolution', () => {
  it('maps a side account to its main account and leaves others alone', () => {
    vi.stubEnv('LINKED_ACCOUNTS', ` ${SIDE} : ${MAIN} `);
    expect(canonicalUserId(SIDE)).toBe(MAIN);
    expect(canonicalUserId(MAIN)).toBe(MAIN);
    expect(canonicalUserId(OTHER)).toBe(OTHER);
    expect(canonicalUserId(undefined)).toBeUndefined();
  });

  it('lists every account of a person, main first', () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${MAIN}`);
    expect(accountIdsFor(SIDE)).toEqual([MAIN, SIDE]);
    expect(accountIdsFor(MAIN)).toEqual([MAIN, SIDE]);
    expect(accountIdsFor(OTHER)).toEqual([OTHER]);
  });

  it('treats a side and a main account as the same person', () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${MAIN}`);
    expect(isSamePerson(SIDE, MAIN)).toBe(true);
    expect(isSamePerson(OTHER, MAIN)).toBe(false);
    expect(isSamePerson(undefined, MAIN)).toBe(false);
  });
});
