import { ChannelType } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUILD_ID } from '../test-support/fakeArchive';
import type { ArchivedChannel } from './archiveStore';
import { type GuildLike, jumpLink, makeAudienceAccess, makeChannelAccess, renderContent } from './search';

const MAIN = '100000000000000001';
const PRIVATE = '100000000000000004';
const THREAD = '100000000000000003';
const EVERYONE = GUILD_ID;
const MODS = '400000000000000001';

// Which targets (member ids or role ids) can view each guild channel.
const VISIBLE: Record<string, string[]> = { [MAIN]: [EVERYONE, MODS, 'member-1'], [PRIVATE]: [MODS] };

function guild(): GuildLike & { roles: { cache: Map<string, { id: string }> } } {
  const channel = (id: string) => ({
    id,
    type: ChannelType.GuildText,
    permissionsFor: (target: { id: string }) => ({ has: () => VISIBLE[id]?.includes(target.id) ?? false }),
  });
  return {
    id: GUILD_ID,
    channels: { cache: new Map([MAIN, PRIVATE].map((id) => [id, channel(id)])) },
    roles: {
      cache: new Map([
        [EVERYONE, { id: EVERYONE }],
        [MODS, { id: MODS }],
      ]),
    },
  };
}

function archived(id: string, type = ChannelType.GuildText, parentId: string | null = null): ArchivedChannel {
  return { id, guildId: GUILD_ID, name: id, parentId, type, updatedAt: 0 };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('makeChannelAccess', () => {
  it("follows the member's ViewChannel permission; threads inherit their parent's; private threads only from inside", () => {
    const access = makeChannelAccess(guild(), { id: 'member-1' }, { currentChannelId: '999' });
    expect(access(archived(MAIN))).toBe(true);
    expect(access(archived(PRIVATE))).toBe(false);
    expect(access(archived(THREAD, ChannelType.PublicThread, MAIN))).toBe(true);
    expect(access(archived(THREAD, ChannelType.PrivateThread, MAIN))).toBe(false);
    expect(access(archived('777'))).toBe(false); // gone from the server
    expect(access({ ...archived(MAIN), guildId: 'other-guild' })).toBe(false);

    const fromThread = makeChannelAccess(guild(), { id: 'member-1' }, { currentChannelId: THREAD });
    expect(fromThread(archived(THREAD, ChannelType.PrivateThread, MAIN))).toBe(true);
  });

  it('allows nothing but the current channel without a guild or member, and never an ignored channel', () => {
    expect(makeChannelAccess(null, null, { currentChannelId: MAIN })(archived(MAIN))).toBe(true);
    expect(makeChannelAccess(guild(), null)(archived(MAIN))).toBe(false);
    vi.stubEnv('ARCHIVE_IGNORE_CHANNELS', MAIN);
    expect(makeChannelAccess(guild(), { id: 'member-1' }, { currentChannelId: MAIN })(archived(MAIN))).toBe(false);
    expect(makeChannelAccess(guild(), { id: 'member-1' })(archived(THREAD, ChannelType.PublicThread, MAIN))).toBe(false);
  });
});

describe('makeAudienceAccess', () => {
  it("counts a channel only when everyone who can read the post's channel can read it too", () => {
    const g = guild();
    const target = {
      id: MAIN,
      type: ChannelType.GuildText,
      permissionsFor: (role: { id: string }) => ({ has: () => VISIBLE[MAIN].includes(role.id) }),
    };
    const access = makeAudienceAccess(g, target as never);
    expect(access(archived(MAIN))).toBe(true);
    expect(access(archived(PRIVATE))).toBe(false);
    expect(access(archived(THREAD, ChannelType.PublicThread, MAIN))).toBe(true);
    expect(access(archived(THREAD, ChannelType.PrivateThread, MAIN))).toBe(false);
  });

  it('counts only the target itself when its audience is member overwrites alone', () => {
    const g = guild();
    const target = { id: PRIVATE, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => false }) };
    const access = makeAudienceAccess(g, target as never);
    expect(access(archived(PRIVATE))).toBe(true);
    expect(access(archived(MAIN))).toBe(false);
  });
});

describe('rendering helpers', () => {
  it('makes Discord markup readable and builds jump links', () => {
    const ctx = { nameOfUser: (id: string) => (id === '1' ? 'Felix' : undefined), nameOfChannel: () => 'clips' };
    expect(renderContent('<@1> <@!2> <@&3> <#4> <a:party:5> <t:1768496400:R>\nnext', ctx)).toBe(
      '@Felix @someone @role #clips :party: 2026-01-15 12:00 ET ↵ next',
    );
    expect(jumpLink({ guildId: null, channelId: '4', id: '5' })).toBe('https://discord.com/channels/@me/4/5');
  });
});
