import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, configWarnings, describeEffectiveConfig, inspectLinkedAccounts, parseLinkedAccounts } from './config';
import { accountIdsFor, canonicalUserId, isSamePerson } from './linkedAccounts';

const MAIN = '100000000000000001';
const SIDE = '100000000000000002';
const OTHER = '100000000000000003';
const THIRD = '100000000000000004';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseLinkedAccounts', () => {
  it('parses side:main pairs and drops malformed entries and self-links', () => {
    const links = parseLinkedAccounts([`${SIDE}:${MAIN}`, 'nope', `${OTHER}:${OTHER}`, `${SIDE}:`, 'a:b', `1:2:3`]);
    expect([...links]).toEqual([[SIDE, MAIN]]);
  });

  it('resolves a chain to its final main account, so every account in it is one person', () => {
    // A third account linked to a side account.
    expect([...parseLinkedAccounts([`${THIRD}:${SIDE}`, `${SIDE}:${MAIN}`])]).toEqual([
      [THIRD, MAIN],
      [SIDE, MAIN],
    ]);
    expect(inspectLinkedAccounts([`${THIRD}:${SIDE}`, `${SIDE}:${MAIN}`]).problems).toEqual([]);
  });

  it('ignores a side account linked to two different mains, and says so', () => {
    const { links, problems } = inspectLinkedAccounts([`${SIDE}:${MAIN}`, `${SIDE}:${OTHER}`, `${THIRD}:${MAIN}`]);
    expect([...links]).toEqual([[THIRD, MAIN]]);
    expect(problems).toEqual([`LINKED_ACCOUNTS links ${SIDE} to several main accounts (${MAIN}, ${OTHER}); ignored`]);
    // The same pair twice is not a conflict.
    expect(inspectLinkedAccounts([`${SIDE}:${MAIN}`, `${SIDE}:${MAIN}`])).toEqual({
      links: new Map([[SIDE, MAIN]]),
      rejected: [],
      problems: [],
    });
  });

  it('ignores accounts linked in a loop (and anything linked into one), and says so', () => {
    const { links, problems } = inspectLinkedAccounts([`${SIDE}:${MAIN}`, `${MAIN}:${SIDE}`, `${THIRD}:${SIDE}`]);
    expect(links.size).toBe(0);
    expect(problems).toEqual([`LINKED_ACCOUNTS links ${SIDE}, ${MAIN}, ${THIRD} in a loop with no main account; ignored`]);
  });

  it('says which entries it dropped and why', () => {
    const { links, rejected } = inspectLinkedAccounts([`${SIDE}:${MAIN}`, 'nope', `${OTHER}:${OTHER}`, `1:2`]);
    expect([...links]).toEqual([[SIDE, MAIN]]);
    expect(rejected).toEqual([
      { entry: 'nope', reason: 'expected sideId:mainId' },
      { entry: `${OTHER}:${OTHER}`, reason: 'links an account to itself' },
      { entry: '1:2', reason: 'both sides must be Discord user ids' },
    ]);
  });

  it('also takes pairs separated by semicolons or line breaks (a pasted multi-line value)', () => {
    const { links, rejected } = inspectLinkedAccounts([`${SIDE}:${MAIN};${THIRD}:${OTHER}\n`]);
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

  it('also names pairs that parse but cannot be resolved, and counts every ignored entry in the summary', () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${MAIN},${SIDE}:${OTHER},nope`);
    expect(configWarnings()).toEqual([
      'LINKED_ACCOUNTS: ignoring "nope" (expected sideId:mainId); that account counts as its own person.',
      `LINKED_ACCOUNTS links ${SIDE} to several main accounts (${MAIN}, ${OTHER}); ignored`,
    ]);
    expect(describeEffectiveConfig().split(' ')).toContain('linkedAccounts=0,ignored:2');
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

  it('treats every account of a chain as the same person', () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${THIRD}:${SIDE},${SIDE}:${MAIN}`);
    expect(canonicalUserId(THIRD)).toBe(MAIN);
    expect(isSamePerson(THIRD, MAIN)).toBe(true);
    expect(isSamePerson(THIRD, SIDE)).toBe(true);
    expect(accountIdsFor(MAIN)).toEqual([MAIN, THIRD, SIDE]);
  });

  it('never merges two people over a cycle', () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${MAIN},${MAIN}:${SIDE}`);
    expect(canonicalUserId(SIDE)).toBe(SIDE);
    expect(canonicalUserId(MAIN)).toBe(MAIN);
    expect(config.server.linkedAccountProblems).toHaveLength(1);
    expect(describeEffectiveConfig().split(' ')).toContain('linkedAccounts=0,ignored:1');
  });

  it('treats a side and a main account as the same person', () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${MAIN}`);
    expect(isSamePerson(SIDE, MAIN)).toBe(true);
    expect(isSamePerson(OTHER, MAIN)).toBe(false);
    expect(isSamePerson(undefined, MAIN)).toBe(false);
  });
});
