import { ChannelType, Collection, type Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveStore, setArchiveStoreForTesting } from '../../archive/archiveStore';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import { BOT_USER_ID, GUILD_ID, archivableMessage, archiveInput, snowflake } from '../../test-support/fakeArchive';
import { setMemoryStoreForTesting } from '../memory';
import { MemoryStore } from '../memory/memoryStore';
import { type AiProvider, type ToolHandlerContext, createTurnEffects } from '../types';
import { messageSearchTools } from './messageSearch';

const MAIN = '100000000000000001';
const CLIPS = '100000000000000002';
const MODLOGS = '100000000000000004';
const THREAD = '100000000000000003';
const FELIX = '200000000000000001';
const JASON = '200000000000000002';
const ASKER = '200000000000000003';
// 2026-01-15 12:00 Eastern (EST, UTC-5).
const T0 = Date.UTC(2026, 0, 15, 17, 0);
const MINUTE = 60_000;

const searchTool = messageSearchTools.find((t) => t.name === 'search_messages');
const contextTool = messageSearchTools.find((t) => t.name === 'get_message_context');
if (!searchTool || !contextTool) throw new Error('message search tools missing');

let store: ArchiveStore;
let memory: MemoryStore;

type AskerOptions = {
  viewable?: string[];
  channelId?: string;
  /** Messages a live Discord fetch returns (get_message_context fallback), per channel. */
  live?: Record<string, Message[]>;
};

/** The triggering message: its author, guild and the ViewChannel answer per guild channel. */
function asker(opts: AskerOptions = {}): Message {
  const viewable = new Set(opts.viewable ?? [MAIN, CLIPS]);
  const guildChannel = (id: string, name: string, type = ChannelType.GuildText) => ({
    id,
    name,
    type,
    parentId: null,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => viewable.has(id) }),
    messages: {
      fetch: async (options: { around: string; limit: number }) =>
        new Collection((opts.live?.[id] ?? []).map((m) => [m.id, m])),
    },
  });
  const channels = new Collection<string, unknown>([
    [MAIN, guildChannel(MAIN, 'banana-combo')],
    [CLIPS, guildChannel(CLIPS, 'clips')],
    [MODLOGS, guildChannel(MODLOGS, 'mod-logs')],
  ]);
  return {
    id: snowflake(T0 + 999 * MINUTE),
    channelId: opts.channelId ?? MAIN,
    author: { id: ASKER },
    member: { id: ASKER },
    client: { user: { id: BOT_USER_ID, username: 'frigidaire', displayName: 'Frigidaire' } },
    guild: {
      id: GUILD_ID,
      channels: {
        cache: channels,
        fetch: async (id: string) => {
          const found = channels.get(id);
          if (!found) throw new Error('Unknown Channel');
          return found;
        },
      },
      members: { me: { displayName: 'Frigidaire' } },
    },
  } as unknown as Message;
}

function ctx(message: Message = asker()): ToolHandlerContext {
  return { message, provider: {} as AiProvider, channelId: message.channelId, turn: createTurnEffects() };
}

function search(args: Record<string, unknown>, message?: Message) {
  return searchTool?.handler(ctx(message), args) ?? Promise.reject(new Error('no tool'));
}

function context(args: Record<string, unknown>, message?: Message) {
  return contextTool?.handler(ctx(message), args) ?? Promise.reject(new Error('no tool'));
}

function seedChannels() {
  store.upsertChannel({ id: MAIN, guildId: GUILD_ID, name: 'banana-combo', parentId: null, type: ChannelType.GuildText });
  store.upsertChannel({ id: CLIPS, guildId: GUILD_ID, name: 'clips', parentId: null, type: ChannelType.GuildText });
  store.upsertChannel({ id: MODLOGS, guildId: GUILD_ID, name: 'mod-logs', parentId: null, type: ChannelType.GuildText });
  store.upsertChannel({
    id: THREAD,
    guildId: GUILD_ID,
    name: 'patch notes',
    parentId: MAIN,
    type: ChannelType.PublicThread,
  });
}

function at(minutes: number, overrides: Parameters<typeof archiveInput>[0] = {}) {
  const createdAt = T0 + minutes * MINUTE;
  return archiveInput({ id: snowflake(createdAt), createdAt, channelId: MAIN, ...overrides });
}

beforeEach(() => {
  store = new ArchiveStore(':memory:');
  setArchiveStoreForTesting(store);
  setBotDbForTesting(new BotDb(':memory:'));
  memory = new MemoryStore(':memory:');
  setMemoryStoreForTesting(memory);
  memory.upsertIdentity(FELIX, 'Felix');
  memory.updateIdentityMeta(FELIX, { irl_name: 'Félix Rouleau', aliases_add: ['fridge'] });
  memory.upsertIdentity(JASON, 'Jason');
  memory.upsertIdentity(ASKER, 'Marc');
  vi.stubEnv('MAIN_CHANNEL_ID', '');
  vi.stubEnv('ARCHIVE_BACKFILL_CHANNELS', '');
  vi.stubEnv('ARCHIVE_IGNORE_CHANNELS', '');
});

afterEach(() => {
  setArchiveStoreForTesting(undefined);
  setBotDbForTesting(undefined);
  setMemoryStoreForTesting(undefined);
  store.close();
  vi.unstubAllEnvs();
});

describe('search_messages', () => {
  it('says so when the archive is empty, mentioning an unfinished import', async () => {
    expect(await search({ query: 'pizza' })).toContain('archive is empty');
    vi.stubEnv('MAIN_CHANNEL_ID', MAIN);
    expect(await search({ query: 'pizza' })).toContain('still importing older history');
  });

  it('asks for something to search for', async () => {
    store.upsertMessage(at(0, { content: 'x y z' }));
    expect(await search({})).toContain('Give me something to search for');
  });

  it('renders hits as "[date ET] #channel Author: content (jump link)", mentions and emojis made readable', async () => {
    seedChannels();
    const hit = at(0, { content: 'pizza with <@200000000000000002> <:kekw:300000000000000001> tonight', authorId: FELIX });
    store.upsertMessages([hit, at(1, { content: 'tacos', authorId: JASON })]);
    const result = await search({ query: 'pizza' });
    expect(result).toContain('1 message(s) matching "pizza"');
    expect(result).toContain(
      `[2026-01-15 12:00 ET] #banana-combo Felix: pizza with @Jason :kekw: tonight (https://discord.com/channels/${GUILD_ID}/${MAIN}/${hit.id})`,
    );
    expect(result).not.toContain('tacos');
  });

  it('flags partial matches and truncates long messages', async () => {
    seedChannels();
    store.upsertMessages([
      at(0, { content: `league patch ${'blah '.repeat(200)}` }),
      at(1, { content: 'league tonight' }),
    ]);
    const result = await search({ query: 'league patch' });
    expect(result).toContain('later ones match only some of the words');
    const lines = result.split('\n');
    expect(lines[1].length).toBeLessThan(450);
    expect(lines[1]).toContain('…');
  });

  it('resolves authors by display name, IRL name, alias, partial name, mention, "me" and the bot', async () => {
    seedChannels();
    store.upsertMessages([
      at(0, { content: 'cheese one', authorId: FELIX, authorName: 'Felix' }),
      at(1, { content: 'cheese two', authorId: JASON, authorName: 'Jason' }),
      at(2, { content: 'cheese three', authorId: ASKER, authorName: 'Marc' }),
      at(3, { content: 'cheese four', authorId: BOT_USER_ID, authorName: 'Frigidaire', source: 'bot' }),
    ]);
    const authorsOf = async (author: string) =>
      (await search({ query: 'cheese', author }))
        .split('\n')
        .slice(1)
        .map((l) => l.match(/#banana-combo (\w+):/)?.[1]);

    expect(await authorsOf('Felix')).toEqual(['Felix']);
    expect(await authorsOf('felix rouleau')).toEqual(['Felix']);
    expect(await authorsOf('Fridge')).toEqual(['Felix']);
    expect(await authorsOf('jas')).toEqual(['Jason']);
    expect(await authorsOf(`<@${JASON}>`)).toEqual(['Jason']);
    expect(await authorsOf('me')).toEqual(['Marc']);
    expect(await authorsOf('you')).toEqual(['Frigidaire']);
    expect(await authorsOf('Frigidaire')).toEqual(['Frigidaire']);
    expect(await search({ query: 'cheese', author: 'Nobody' })).toContain(`I don't know anyone called "Nobody"`);
  });

  it('falls back to author names the archive has seen (people the identity table lacks)', async () => {
    seedChannels();
    store.upsertMessage(at(0, { content: 'old relay', authorId: null, authorName: 'Ghosty', source: 'relay' }));
    expect(await search({ author: 'ghosty' })).toContain('Ghosty: old relay');
  });

  it('filters by channel name (threads included) or id, and reports unknown channels', async () => {
    seedChannels();
    store.upsertMessages([
      at(0, { content: 'clip here', channelId: CLIPS }),
      at(1, { content: 'clip there' }),
      at(2, { content: 'clip thread', channelId: THREAD, parentChannelId: MAIN }),
    ]);
    const inClips = await search({ query: 'clip', channel: '#clips' });
    expect(inClips).toContain('clip here');
    expect(inClips).not.toContain('clip there');
    const inMain = await search({ query: 'clip', channel: 'Banana Combo' });
    expect(inMain).toContain('clip there');
    expect(inMain).toContain('#patch notes');
    expect(await search({ query: 'clip', channel: `<#${CLIPS}>` })).toContain('clip here');
    expect(await search({ query: 'clip', channel: 'general' })).toContain('No channel matching "general"');
  });

  it('reads after/before as Eastern wall-clock time and rejects unreadable dates', async () => {
    seedChannels();
    // 2026-01-15 11:59 ET and 12:01 ET.
    store.upsertMessages([at(-1, { content: 'morning news' }), at(1, { content: 'afternoon news' })]);
    const after = await search({ query: 'news', after: '2026-01-15 12:00' });
    expect(after).toContain('afternoon');
    expect(after).not.toContain('morning');
    const before = await search({ query: 'news', before: '2026-01-15 12:00' });
    expect(before).toContain('morning');
    expect(before).not.toContain('afternoon');
    expect(await search({ query: 'news', after: 'last tuesday' })).toContain(`Couldn't read the date "last tuesday"`);
  });

  it('only shows channels the asker can read, plus the one they are asking from', async () => {
    seedChannels();
    store.upsertMessages([at(0, { content: 'secret ban', channelId: MODLOGS }), at(1, { content: 'public ban' })]);
    const result = await search({ query: 'ban' });
    expect(result).toContain('public ban');
    expect(result).not.toContain('secret');
    expect(await search({ query: 'ban' }, asker({ channelId: MODLOGS }))).toContain('secret ban');
  });

  it('never shows ignored channels', async () => {
    seedChannels();
    store.upsertMessages([at(0, { content: 'clip one', channelId: CLIPS })]);
    vi.stubEnv('ARCHIVE_IGNORE_CHANNELS', CLIPS);
    expect(await search({ query: 'clip' })).toContain('No messages matching "clip"');
  });

  it('lists the latest messages when there is no query, with the total and a limit', async () => {
    seedChannels();
    store.upsertMessages([0, 1, 2, 3, 4].map((i) => at(i, { content: `msg ${i}`, authorId: JASON })));
    const result = await search({ author: 'Jason', limit: 2 });
    expect(result).toContain('5 message(s) by Jason; the latest 2, oldest first');
    expect(result).toContain('msg 3');
    expect(result).toContain('msg 4');
    expect(result).not.toContain('msg 2');
    expect(await search({ author: 'Jason', limit: '999' })).toContain('5 message(s) by Jason, oldest first');
  });

  it('appends the import notice while a configured channel is still backfilling', async () => {
    seedChannels();
    store.upsertMessage(at(0, { content: 'pizza' }));
    vi.stubEnv('ARCHIVE_BACKFILL_CHANNELS', MAIN);
    expect(await search({ query: 'pizza' })).toContain('it currently reaches back to 2026-01-15');
    store.saveBackfillPage(MAIN, [], { cursorId: null, cursorAt: null, fetched: 0, done: true });
    expect(await search({ query: 'pizza' })).not.toContain('still importing');
  });

  it('answers in character when the archive fails, and is offered only when the archive is enabled', async () => {
    store.close();
    expect(await search({ query: 'x' })).toBe('The message archive is unavailable right now.');
    store = new ArchiveStore(':memory:');
    expect(searchTool.isEnabled?.()).toBe(true);
    vi.stubEnv('ARCHIVE_ENABLED', 'false');
    expect(searchTool.isEnabled?.()).toBe(false);
    expect(contextTool.isEnabled?.()).toBe(false);
  });
});

describe('get_message_context', () => {
  function seedConversation() {
    seedChannels();
    const messages = [0, 1, 2, 3, 4, 5, 6].map((i) => at(i, { content: `line ${i}`, authorId: i % 2 ? JASON : FELIX }));
    store.upsertMessages([...messages, at(3.5, { content: 'other channel', channelId: CLIPS })]);
    return messages;
  }

  it('shows the messages around one, by id or jump link, with the target marked', async () => {
    const messages = seedConversation();
    const byId = await context({ message: messages[3].id, before: 2, after: 1 });
    expect(byId.split('\n')).toEqual([
      'Conversation around that message in #banana-combo (→ marks it):',
      expect.stringContaining('Jason: line 1'),
      expect.stringContaining('Felix: line 2'),
      expect.stringMatching(/^→ .*Jason: line 3/),
      expect.stringContaining('Felix: line 4'),
    ]);
    const link = `https://discord.com/channels/${GUILD_ID}/${MAIN}/${messages[3].id}`;
    const byLink = await context({ message: link, before: '0', after: 0 });
    expect(byLink.split('\n')).toHaveLength(2);
  });

  it('refuses bad references, deleted messages and channels the asker cannot read', async () => {
    const messages = seedConversation();
    expect(await context({ message: 'that one' })).toContain('Pass a message id or a Discord message link');
    store.markDeleted([messages[1].id], T0 + 99 * MINUTE);
    expect(await context({ message: messages[1].id })).toBe('That message was deleted.');
    const secret = at(10, { content: 'secret', channelId: MODLOGS });
    store.upsertMessage(secret);
    expect(await context({ message: secret.id })).toContain("in a channel you can't read");
  });

  it('reads a message the archive does not have straight from Discord (read-only)', async () => {
    seedChannels();
    const live = [0, 1, 2].map((i) =>
      archivableMessage({
        id: snowflake(T0 - 1000 * MINUTE + i * MINUTE),
        createdAt: T0 - 1000 * MINUTE + i * MINUTE,
        channelId: CLIPS,
        channelName: 'clips',
        content: `live ${i}`,
      }),
    );
    const result = await context(
      { message: `https://discord.com/channels/${GUILD_ID}/${CLIPS}/${live[1].id}`, before: 1, after: 1 },
      asker({ live: { [CLIPS]: live } }),
    );
    expect(result).toContain('read live from Discord');
    expect(result).toMatch(/→ .*live 1/);
    expect(result).toContain('live 0');
    expect(store.getMessage(live[1].id)).toBeUndefined();

    const hidden = await context(
      { message: `https://discord.com/channels/${GUILD_ID}/${MODLOGS}/${live[1].id}` },
      asker({ live: { [MODLOGS]: live } }),
    );
    expect(hidden).toContain("in a channel you can't read");

    const missing = await context({ message: snowflake(T0 - 5000 * MINUTE) });
    expect(missing).toContain("isn't in the archive");
  });
});
