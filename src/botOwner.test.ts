import { Collection, type Client } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applicationOwnerSource, BotOwners, isBotOwner } from './botOwner';

const OWNER = '100000000000000001';
const OWNER_ALT = '100000000000000011';
const TEAMMATE = '100000000000000002';
const MEMBER = '100000000000000003';

afterEach(() => {
  vi.unstubAllEnvs();
});

function clientWithOwner(owner: unknown, opts: { fail?: boolean } = {}): { client: Client; fetches: () => number } {
  let fetches = 0;
  const application = {
    fetch: async () => {
      fetches++;
      if (opts.fail) throw new Error('503');
      return { owner };
    },
  };
  return { client: { application } as unknown as Client, fetches: () => fetches };
}

describe('BotOwners', () => {
  it('uses BOT_OWNER_USER_IDS when set, without asking Discord', async () => {
    const source = vi.fn(async () => [MEMBER]);
    const owners = new BotOwners({ source, configured: () => [OWNER] });
    expect(await owners.isOwner(OWNER)).toBe(true);
    expect(await owners.isOwner(MEMBER)).toBe(false);
    expect(source).not.toHaveBeenCalled();
  });

  it('falls back to the application owner, fetched once', async () => {
    const source = vi.fn(async () => [OWNER]);
    const owners = new BotOwners({ source, configured: () => [] });
    expect(await Promise.all([owners.isOwner(OWNER), owners.isOwner(MEMBER)])).toEqual([true, false]);
    expect(await owners.isOwner(OWNER)).toBe(true);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('fails closed while the owner cannot be fetched, and retries on the next check', async () => {
    let calls = 0;
    const owners = new BotOwners({
      source: async () => {
        calls++;
        if (calls === 1) throw new Error('Discord is down');
        return [OWNER];
      },
      configured: () => [],
    });
    expect(await owners.isOwner(OWNER)).toBe(false);
    expect(await owners.isOwner(OWNER)).toBe(true);
  });

  it("counts an owner's linked side account as the owner", async () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${OWNER_ALT}:${OWNER}`);
    const owners = new BotOwners({ source: async () => [OWNER], configured: () => [] });
    expect(await owners.isOwner(OWNER_ALT)).toBe(true);
  });
});

describe('applicationOwnerSource', () => {
  it('reads a user owner and a team', async () => {
    expect(await applicationOwnerSource(clientWithOwner({ id: OWNER }).client)()).toEqual([OWNER]);
    const team = {
      members: new Collection([
        [OWNER, { user: { id: OWNER } }],
        [TEAMMATE, { user: { id: TEAMMATE } }],
      ]),
    };
    expect(await applicationOwnerSource(clientWithOwner(team).client)()).toEqual([OWNER, TEAMMATE]);
    expect(await applicationOwnerSource(clientWithOwner(null).client)()).toEqual([]);
  });
});

describe('isBotOwner', () => {
  it('asks the client once per process and never throws', async () => {
    vi.stubEnv('BOT_OWNER_USER_IDS', undefined);
    const { client, fetches } = clientWithOwner({ id: OWNER });
    expect(await isBotOwner(client, OWNER)).toBe(true);
    expect(await isBotOwner(client, MEMBER)).toBe(false);
    expect(fetches()).toBe(1);

    const broken = clientWithOwner({ id: OWNER }, { fail: true });
    expect(await isBotOwner(broken.client, OWNER)).toBe(false);
  });

  it('prefers BOT_OWNER_USER_IDS', async () => {
    vi.stubEnv('BOT_OWNER_USER_IDS', MEMBER);
    const { client, fetches } = clientWithOwner({ id: OWNER });
    expect(await isBotOwner(client, MEMBER)).toBe(true);
    expect(await isBotOwner(client, OWNER)).toBe(false);
    expect(fetches()).toBe(0);
  });
});
