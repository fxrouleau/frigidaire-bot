import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_USER_ID, archiveInput, snowflake } from '../test-support/fakeArchive';
import { ArchiveStore, VOICE_MESSAGE_FLAG } from './archiveStore';
import { getArchivedMessages } from './index';
import { classifyLink, computeWrappedStats, messageCountsByAuthor } from './stats';

const MAIN = '100000000000000001';
const CLIPS = '100000000000000002';
const THREAD = '100000000000000003';
const REMI = '200000000000000001';
const JASPER = '200000000000000002';
const MARC = '200000000000000003';
// January 2026 in Eastern time (EST, UTC-5).
const START = Date.UTC(2026, 0, 1, 5, 0);
const END = Date.UTC(2026, 1, 1, 5, 0);
const MINUTE = 60_000;

let store: ArchiveStore;
let seq = 0;

/** A message at an Eastern wall-clock time in January 2026 (EST = UTC-5). */
function et(day: number, hour: number, minute: number, overrides: Parameters<typeof archiveInput>[0] = {}) {
  const createdAt = Date.UTC(2026, 0, day, hour + 5, minute);
  return archiveInput({ id: snowflake(createdAt, seq++), createdAt, channelId: MAIN, ...overrides });
}

beforeEach(() => {
  store = new ArchiveStore(':memory:');
  seq = 0;
});

afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
});

describe('classifyLink', () => {
  it('maps hosts (fixer domains included) to platforms and ignores Discord links', () => {
    expect(classifyLink('https://x.com/a/status/1')).toBe('twitter');
    expect(classifyLink('https://fixvx.com/a/status/1')).toBe('twitter');
    expect(classifyLink('https://www.instagram.com/reel/abc/')).toBe('instagram');
    expect(classifyLink('https://vm.tiktok.com/xyz')).toBe('tiktok');
    expect(classifyLink('https://youtu.be/abc')).toBe('youtube');
    expect(classifyLink('https://old.reddit.com/r/x')).toBe('reddit');
    expect(classifyLink('https://tenor.com/view/x')).toBe('gifs');
    expect(classifyLink('https://example.com/')).toBe('other');
    expect(classifyLink('https://discord.com/channels/1/2/3')).toBeUndefined();
    expect(classifyLink('https://cdn.discordapp.com/attachments/1/2/x.png')).toBeUndefined();
    expect(classifyLink('not a url')).toBeUndefined();
  });

  it('counts configured fixer domains as their platform', () => {
    vi.stubEnv('INSTAGRAM_FIXERS', 'newfixer.example');
    expect(classifyLink('https://newfixer.example/reel/abc')).toBe('instagram');
  });
});

describe('computeWrappedStats', () => {
  function seed() {
    const messages = [
      // Remi: 4 messages, the busiest day (Jan 10), one edited twice.
      et(10, 21, 0, { authorId: REMI, content: 'lol <:kekw:300000000000000001> <:kekw:300000000000000001>' }),
      et(10, 21, 5, { authorId: REMI, content: 'https://x.com/a/status/1 and https://youtu.be/b' }),
      et(10, 21, 10, { authorId: REMI, content: 'edited thing' }),
      et(10, 22, 0, { authorId: REMI, content: `${'long '.repeat(60)}ramble` }),
      // Jasper: 2 messages + one regret repost; one voice message; an animated emoji.
      et(12, 21, 30, { authorId: JASPER, authorName: 'Jasper', content: '<a:party:300000000000000002> https://example.com' }),
      et(12, 9, 0, { authorId: JASPER, authorName: 'Jasper', flags: VOICE_MESSAGE_FLAG, hasAudio: true }),
      et(12, 9, 1, { authorId: JASPER, authorName: 'Jasper', source: 'relay', relayKind: 'regret', content: 'hot take' }),
      // Marc: a thread message (counts for the parent channel) that pings the bot.
      et(15, 21, 0, {
        authorId: MARC,
        authorName: 'Marc',
        channelId: THREAD,
        parentChannelId: MAIN,
        content: `<@${BOT_USER_ID}> settle this`,
      }),
      // In #clips.
      et(20, 21, 0, { authorId: MARC, authorName: 'Marc', channelId: CLIPS, content: 'https://clips.twitch.tv/x' }),
      // The bot's reply (not a member message) and a reply to it (a ping).
      et(15, 21, 1, { authorId: BOT_USER_ID, authorName: 'Frigidaire', source: 'bot', content: 'no' }),
    ];
    const botReply = messages[messages.length - 1];
    messages.push(et(15, 21, 2, { authorId: MARC, authorName: 'Marc', content: 'yes', replyToId: botReply.id }));
    // Outside the range (Feb 1 00:30 ET) and just inside (Jan 1 00:00 ET).
    messages.push(archiveInput({ id: snowflake(END + 30 * MINUTE), createdAt: END + 30 * MINUTE, authorId: REMI }));
    messages.push(archiveInput({ id: snowflake(START, 99), createdAt: START, authorId: MARC, authorName: 'Marc' }));
    store.upsertMessages(messages);

    // Edits: Remi edited one message twice.
    store.upsertMessage({ ...messages[2], content: 'edited thing v2', editedAt: messages[2].createdAt + 1000 });
    store.upsertMessage({ ...messages[2], content: 'edited thing v3', editedAt: messages[2].createdAt + 2000 });

    // Deletions: Jasper deleted a message himself (and regretted it: the relay above) …
    const regretted = et(12, 9, 0, { authorId: JASPER, authorName: 'Jasper', content: 'hot take' });
    // … and the bot replaced Remi's raw link with a link-fix relay (not Remi's deletion).
    const linkOriginal = et(11, 12, 0, { authorId: REMI, content: 'https://instagram.com/reel/x' });
    const linkRelay = {
      ...et(11, 12, 0, { authorId: REMI, source: 'relay' as const, relayKind: 'link_fix', content: 'https://kkinstagram.com/reel/x' }),
      createdAt: linkOriginal.createdAt + 1500,
    };
    store.upsertMessages([regretted, linkOriginal, linkRelay]);
    store.markDeleted([regretted.id], regretted.createdAt + 20_000);
    store.markDeleted([linkOriginal.id], linkOriginal.createdAt + 2000);
    return messages;
  }

  it('computes every Wrapped number for a month', () => {
    seed();
    const stats = computeWrappedStats({ startMs: START, endMs: END }, { store, botUserId: BOT_USER_ID });

    // Members' live messages: Remi 4 + link relay 1, Jasper 3, Marc 4 (thread, clips, reply, Jan 1).
    expect(stats.totalMessages).toBe(12);
    expect(stats.activeMembers).toBe(3);
    expect(stats.topMembers.map((m) => [m.authorId, m.count])).toEqual([
      [REMI, 5],
      [MARC, 4],
      [JASPER, 3],
    ]);
    expect(stats.busiestDay).toEqual({ date: '2026-01-10', count: 4 });
    expect(stats.busiestHour).toEqual({ hour: 21, count: 7 }); // 9 PM ET; the bot's 21:01 reply is not a member message
    expect(stats.topChannel).toEqual({ channelId: MAIN, count: 11 });
    expect(stats.topEmojis).toEqual([
      { id: '300000000000000001', name: 'kekw', animated: false, count: 2 },
      { id: '300000000000000002', name: 'party', animated: true, count: 1 },
    ]);
    expect(stats.links).toEqual([
      { platform: 'instagram', count: 1 },
      { platform: 'twitch', count: 1 },
      { platform: 'twitter', count: 1 },
      { platform: 'youtube', count: 1 },
      { platform: 'other', count: 1 },
    ]);
    expect(stats.voice).toEqual({ total: 1, top: { authorId: JASPER, authorName: 'Jasper', count: 1 } });
    expect(stats.regrets).toEqual({ total: 1, top: [{ authorId: JASPER, authorName: 'Jasper', count: 1 }] });
    expect(stats.edits).toEqual({ total: 2, top: { authorId: REMI, authorName: 'Remi', count: 2 } });
    expect(stats.deletions).toEqual({ total: 1, top: { authorId: JASPER, authorName: 'Jasper', count: 1 } });
    expect(stats.longest).toMatchObject({ authorId: REMI, length: 306, channelId: MAIN });
    expect(stats.botPings).toEqual({
      total: 2,
      top: { authorId: MARC, authorName: 'Marc', count: 2 },
      botReplies: 1,
    });
  });

  it('respects a channel scope and skips bot pings without a bot id', () => {
    seed();
    const stats = computeWrappedStats({ startMs: START, endMs: END, channelIds: [CLIPS] }, { store });
    expect(stats.totalMessages).toBe(1);
    expect(stats.topChannel).toEqual({ channelId: CLIPS, count: 1 });
    expect(stats.botPings).toEqual({ total: 0, botReplies: 0 });
    expect(stats.longest?.channelId).toBe(CLIPS);
  });

  it('is empty (no top lists, no longest) for a quiet range', () => {
    const stats = computeWrappedStats({ startMs: START, endMs: END }, { store });
    expect(stats).toMatchObject({
      totalMessages: 0,
      activeMembers: 0,
      topMembers: [],
      topEmojis: [],
      links: [],
      busiestDay: undefined,
      longest: undefined,
    });
  });

  it('finds the most reacted member message, never counting the bot, the bot’s own reaction, or deleted messages', () => {
    const kekw = { id: '300000000000000001', name: 'kekw', animated: true };
    const messages = [
      // 3 member reactions + the bot's own 💀 (count 4, me) → 3.
      et(3, 12, 0, {
        authorId: REMI,
        content: 'first',
        reactions: [
          { ...kekw, count: 2 },
          { id: null, name: '💀', count: 2, me: true },
        ],
      }),
      // Only the bot reacted: not reacted at all.
      et(4, 12, 0, { authorId: JASPER, authorName: 'Jasper', reactions: [{ id: null, name: '🔥', count: 1, me: true }] }),
      // A tie with the first (3), but later: loses.
      et(5, 12, 0, { authorId: MARC, authorName: 'Marc', content: 'tie', reactions: [{ id: null, name: '😂', count: 3 }] }),
      // More reactions, but the bot's own reply: never a member message.
      et(6, 12, 0, { authorId: BOT_USER_ID, source: 'bot', reactions: [{ id: null, name: '😂', count: 9 }] }),
      // More reactions, but deleted.
      et(7, 12, 0, { authorId: MARC, authorName: 'Marc', reactions: [{ id: null, name: '😂', count: 8 }] }),
      // Most reactions, but outside the scope below.
      et(8, 12, 0, { authorId: MARC, authorName: 'Marc', channelId: CLIPS, reactions: [{ id: null, name: '😂', count: 7 }] }),
    ];
    store.upsertMessages(messages);
    store.markDeleted([messages[4].id], messages[4].createdAt + 1000);

    const scoped = computeWrappedStats({ startMs: START, endMs: END, channelIds: [MAIN] }, { store });
    expect(scoped.mostReacted).toEqual({
      authorId: REMI,
      authorName: 'Remi',
      total: 3,
      reactions: [
        { id: '300000000000000001', name: 'kekw', animated: true, count: 2 },
        { id: null, name: '💀', animated: false, count: 1 },
      ],
      content: 'first',
      messageId: messages[0].id,
      channelId: MAIN,
      guildId: messages[0].guildId,
    });

    const everywhere = computeWrappedStats({ startMs: START, endMs: END }, { store });
    expect(everywhere.mostReacted).toMatchObject({ channelId: CLIPS, total: 7, authorName: 'Marc' });
  });

  it('describes an image-only most reacted message by what it carried', () => {
    store.upsertMessages([
      et(3, 12, 0, {
        attachments: [{ name: 'meme.png', type: 'image/png', size: 10, url: 'https://cdn.example/meme.png' }],
        embeds: [{ title: 'ignored when there is a file' }],
        reactions: [{ id: null, name: '😂', count: 5 }],
      }),
    ]);
    const stats = computeWrappedStats({ startMs: START, endMs: END }, { store });
    expect(stats.mostReacted).toMatchObject({ content: '', attachmentName: 'meme.png', linkTitle: 'ignored when there is a file' });
    expect(computeWrappedStats({ startMs: END, endMs: END + MINUTE }, { store }).mostReacted).toBeUndefined();
  });

  it('exposes per-author counts and channel reads for other features', () => {
    seed();
    expect(messageCountsByAuthor({ startMs: START, endMs: END }, store, 1)).toEqual([
      { authorId: REMI, authorName: 'Remi', count: 5 },
    ]);
  });
});

describe('getArchivedMessages', () => {
  it('reads the shared archive, and is empty when the archive is disabled', async () => {
    const { setArchiveStoreForTesting } = await import('./archiveStore');
    setArchiveStoreForTesting(store);
    try {
      store.upsertMessages([et(3, 12, 0, { content: 'a' }), et(3, 12, 1, { content: 'b', source: 'bot' })]);
      expect(getArchivedMessages(MAIN, START, END).map((m) => [m.content, m.source])).toEqual([
        ['a', 'human'],
        ['b', 'bot'],
      ]);
      vi.stubEnv('ARCHIVE_ENABLED', 'false');
      expect(getArchivedMessages(MAIN, START, END)).toEqual([]);
    } finally {
      setArchiveStoreForTesting(undefined);
    }
  });
});
