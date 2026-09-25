import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from './memory/memoryStore';
import { formatIdentityLines } from './promptSections';

// Fake ids only (the repo is public).
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('formatIdentityLines (SERVER PEOPLE)', () => {
  it('shows the display name, @handle, id, real name, nicknames and the first-seen name', () => {
    const wheezer = identity('100000000000000001', 'Wheezer', {
      username: 'wheezy_d',
      canonical_name: 'OldNick',
      irl_name: 'Derrick',
      aliases: ['D', 'Wheez'],
    });
    expect(formatIdentityLines([wheezer])).toEqual([
      '- Wheezer @wheezy_d (id:100000000000000001) — real name Derrick; also called D, Wheez; formerly OldNick',
    ]);
  });

  it('keeps a bare line when there is nothing else to say, and skips a handle that is just the name', () => {
    expect(formatIdentityLines([identity('100000000000000002', 'Simon', { username: 'simon' })])).toEqual([
      '- Simon (id:100000000000000002)',
    ]);
  });

  it('still shows a real name that equals the display name (it tells the model the name is real)', () => {
    expect(formatIdentityLines([identity('100000000000000003', 'Yi', { irl_name: 'Yi', username: 'kizanz' })])).toEqual([
      '- Yi @kizanz (id:100000000000000003) — real name Yi',
    ]);
  });

  it('skips inactive identities', () => {
    expect(formatIdentityLines([identity('100000000000000004', 'Gone', { active: 0 })])).toEqual([]);
  });

  it("folds a linked side account into its member's line instead of listing another person", () => {
    vi.stubEnv('LINKED_ACCOUNTS', '100000000000000006:100000000000000005');
    const lines = formatIdentityLines([
      identity('100000000000000006', 'Ptoughneigh', { username: 'triceclone', aliases: ['Tricey'] }),
      identity('100000000000000005', 'Tony', { username: 'tony_main', irl_name: 'Anthony' }),
      identity('100000000000000001', 'Wheezer'),
    ]);
    expect(lines).toEqual([
      '- Tony @tony_main (id:100000000000000005) — real name Anthony; also called Tricey; also posts as Ptoughneigh @triceclone (id:100000000000000006)',
      '- Wheezer (id:100000000000000001)',
    ]);
  });

  it('labels a member only seen on their side account under the main id', () => {
    vi.stubEnv('LINKED_ACCOUNTS', '100000000000000006:100000000000000005');
    expect(formatIdentityLines([identity('100000000000000006', 'Ptoughneigh', { username: 'triceclone' })])).toEqual([
      '- Ptoughneigh (id:100000000000000005) — also posts as Ptoughneigh @triceclone (id:100000000000000006)',
    ]);
  });
});
