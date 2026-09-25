import { afterEach, describe, expect, it, vi } from 'vitest';
import { configWarnings, parseLinkedAccounts, parseLinkedAccountsReport } from './config';
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

  it('says which entries it dropped and why', () => {
    const { links, rejected } = parseLinkedAccountsReport([`${SIDE}:${MAIN}`, 'nope', `${OTHER}:${OTHER}`, `1:2`]);
    expect([...links]).toEqual([[SIDE, MAIN]]);
    expect(rejected).toEqual([
      { entry: 'nope', reason: 'expected sideId:mainId' },
      { entry: `${OTHER}:${OTHER}`, reason: 'links an account to itself' },
      { entry: '1:2', reason: 'both sides must be Discord user ids' },
    ]);
  });

  it('also takes pairs separated by semicolons or line breaks (a pasted multi-line value)', () => {
    const THIRD = '100000000000000004';
    const { links, rejected } = parseLinkedAccountsReport([`${SIDE}:${MAIN};${THIRD}:${OTHER}\n`]);
    expect([...links]).toEqual([
      [SIDE, MAIN],
      [THIRD, OTHER],
    ]);
    expect(rejected).toEqual([]);
  });
});

describe('configWarnings', () => {
  it('names each LINKED_ACCOUNTS entry that was dropped, so a lost link shows up in the startup log', () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${MAIN},${OTHER}-${MAIN}`);
    expect(configWarnings()).toEqual([
      `LINKED_ACCOUNTS: ignoring "${OTHER}-${MAIN}" (expected sideId:mainId); that account counts as its own person.`,
    ]);
  });

  it('is empty when everything parsed', () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${MAIN}`);
    expect(configWarnings()).toEqual([]);
    vi.stubEnv('LINKED_ACCOUNTS', '');
    expect(configWarnings()).toEqual([]);
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
