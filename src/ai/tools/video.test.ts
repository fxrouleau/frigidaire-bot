import { ChannelType, Collection, type Message } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import { FakeProvider } from '../../test-support/fakeProvider';
import { UNTRUSTED_HEADER } from '../linkReader/format';
import type { LinkReadResult } from '../linkReader/types';
import type { VideoInput, VideoOutcome } from '../media';
import { toolDefinitions } from '../tools';
import { type ToolHandlerContext, createTurnEffects } from '../types';
import { WATCH_RESULT_HEADER, type WatchVideoDeps, createWatchVideoTool } from './video';

const CH = '555000000000000001';
const CLIP = 'https://cdn.discordapp.com/attachments/1/2/clip.mp4';
const OLD_CLIP = 'https://cdn.discordapp.com/attachments/1/9/older.mp4';
const ANSWER = 'At 0:27 he yells "no way, NO WAY".';

function videoPost(id: string, url = CLIP, extra: Parameters<typeof createFakeMessage>[0] = {}): Message {
  return createFakeMessage({
    messageId: id,
    channelId: CH,
    authorDisplayName: 'Jason',
    content: 'LMAOOO',
    attachments: [{ url, contentType: 'video/mp4', name: url.split('/').pop(), duration: 31 }],
    ...extra,
  }).message;
}

function setup(outcome: VideoOutcome = { status: 'ok', text: ANSWER, cached: false }, peeks: Record<string, LinkReadResult> = {}) {
  const watched: VideoInput[] = [];
  const read: Array<{ url: string; question: string }> = [];
  const deps: WatchVideoDeps = {
    watch: async (input) => {
      watched.push(input);
      return outcome;
    },
    readLink: async (url, question) => {
      read.push({ url, question });
      return {
        ok: true,
        content: {
          url,
          source: 'twitter',
          kind: 'tweet',
          media: [{ type: 'video', url: 'https://video.twimg.com/v.mp4', answer: { question, text: 'he says gg' } }],
        },
      };
    },
    peekLink: (url) => peeks[url],
  };
  return { tool: createWatchVideoTool(deps), watched, read };
}

function ctx(message: Message): ToolHandlerContext {
  return { message, provider: new FakeProvider([]), channelId: message.channelId, turn: createTurnEffects() };
}

function asker(opts: Parameters<typeof createFakeMessage>[0] = {}) {
  return createFakeMessage({ messageId: '900000000000000100', channelId: CH, content: 'fridge what does he yell', ...opts });
}

describe('watch_video', () => {
  it('is offered to the chat model', () => {
    expect(toolDefinitions.map((t) => t.name)).toContain('watch_video');
  });

  it('asks about the video in the current message, with who posted it', async () => {
    const { tool, watched } = setup();
    const message = videoPost('900000000000000100');

    const output = await tool.handler(ctx(message), { question: ' what does he yell at the end? ' });

    expect(watched).toEqual([
      {
        url: CLIP,
        contentType: 'video/mp4',
        durationSecs: 31,
        context: 'Posted by Jason with the message: LMAOOO',
        question: 'what does he yell at the end?',
      },
    ]);
    expect(output).toBe(
      `${WATCH_RESULT_HEADER}\nWatched clip.mp4 from Jason (0:31) for: "what does he yell at the end?"\n${ANSWER}`,
    );
  });

  it('finds the video in the message being replied to', async () => {
    const { tool, watched } = setup();
    const replied = videoPost('900000000000000050');
    const { message } = asker({ referencedMessageId: replied.id, fetchedMessageById: { [replied.id]: replied } });

    await tool.handler(ctx(message), { question: 'who is that?' });

    expect(watched[0].url).toBe(CLIP);
  });

  it('otherwise takes the most recent video in the channel', async () => {
    const { tool, watched } = setup();
    const older = videoPost('900000000000000010', OLD_CLIP);
    const newer = videoPost('900000000000000020');
    const chatter = createFakeMessage({ messageId: '900000000000000030', channelId: CH, content: 'lol' }).message;
    const { message } = asker({ channelMessages: [older, newer, chatter] });

    await tool.handler(ctx(message), { question: 'who is that?' });

    expect(watched[0].url).toBe(CLIP);
  });

  it('takes a recent link only when it is known to carry a video', async () => {
    const tweet = 'https://x.com/someone/status/1';
    const peeks: Record<string, LinkReadResult> = {
      [tweet]: {
        ok: true,
        content: { url: tweet, source: 'twitter', kind: 'tweet', media: [{ type: 'video', url: 'https://video.twimg.com/v.mp4' }] },
      },
    };
    const { tool, read } = setup(undefined, peeks);
    const withVideo = createFakeMessage({ messageId: '900000000000000010', channelId: CH, content: `look ${tweet}` }).message;
    const plainLink = createFakeMessage({
      messageId: '900000000000000020',
      channelId: CH,
      content: 'https://news.example/article',
    }).message;
    const { message } = asker({ channelMessages: [withVideo, plainLink] });

    const output = await tool.handler(ctx(message), { question: 'what does he say?' });

    expect(read).toEqual([{ url: tweet, question: 'what does he say?' }]);
    expect(output.startsWith(UNTRUSTED_HEADER)).toBe(true);
    expect(output).toContain('asked "what does he say?" — watching it says: he says gg');
  });

  it('takes the msg:<id> handle from a [video …] line', async () => {
    const { tool, watched } = setup();
    const target = videoPost('900000000000000042', OLD_CLIP);
    const { message } = asker({ fetchedMessageById: { [target.id]: target } });

    await tool.handler(ctx(message), { question: 'who scores?', message_or_url: 'msg:900000000000000042' });

    expect(watched[0].url).toBe(OLD_CLIP);
  });

  it('follows a jump link to this channel, and refuses other servers', async () => {
    const { tool, watched } = setup();
    const target = videoPost('900000000000000042', OLD_CLIP);
    const { message } = asker({ fetchedMessageById: { [target.id]: target } });

    await tool.handler(ctx(message), {
      question: 'who scores?',
      message_or_url: `https://discord.com/channels/guild-1/${CH}/900000000000000042`,
    });
    expect(watched[0].url).toBe(OLD_CLIP);

    const elsewhere = await tool.handler(ctx(message), {
      question: 'who scores?',
      message_or_url: 'https://discord.com/channels/999/777000000000000001/900000000000000042',
    });
    expect(elsewhere).toBe('That message is outside this server.');
  });

  it("won't watch a video in a channel the asker can't read", async () => {
    const { tool, watched } = setup();
    const secret = videoPost('900000000000000077');
    const modLogs = {
      id: '761000000000000001',
      name: 'mod-logs',
      type: ChannelType.GuildText,
      parentId: null,
      guildId: 'guild-1',
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => false }),
      messages: { fetch: async () => secret },
    };
    const { message } = asker();
    Object.assign(message, {
      guild: {
        id: 'guild-1',
        channels: { cache: new Collection([[modLogs.id, modLogs]]), fetch: async () => modLogs },
      },
      member: { id: 'asker' },
    });

    const output = await tool.handler(ctx(message), {
      question: 'what happens?',
      message_or_url: `https://discord.com/channels/guild-1/${modLogs.id}/900000000000000077`,
    });

    expect(output).toBe("That message is in a channel you can't read, so I won't watch it.");
    expect(watched).toEqual([]);
  });

  it('hands other URLs to the link reader with the question', async () => {
    const { tool, read, watched } = setup();
    const output = await tool.handler(ctx(asker().message), {
      question: 'what song is that?',
      message_or_url: '<https://www.tiktok.com/@a/video/1>',
    });
    expect(read).toEqual([{ url: 'https://www.tiktok.com/@a/video/1', question: 'what song is that?' }]);
    expect(watched).toEqual([]);
    expect(output).toContain('watching it says: he says gg');
  });

  it("says so, in character, when today's video budget is spent", async () => {
    const { tool } = setup({ status: 'over_budget' });
    const output = await tool.handler(ctx(videoPost('900000000000000100')), { question: 'who?' });
    expect(output).toBe(
      "Didn't watch clip.mp4 from Jason: not watched: out of popcorn money for today, the daily video budget is spent until midnight Eastern. Say so in your own words.",
    );
  });

  it('reports other outcomes plainly', async () => {
    const { tool } = setup({ status: 'too_large' });
    expect(await tool.handler(ctx(videoPost('900000000000000100')), { question: 'who?' })).toBe(
      "Didn't watch clip.mp4 from Jason: too large to watch.",
    );
  });

  it('needs a question, and says when there is no video to watch', async () => {
    const { tool, watched } = setup();
    expect(await tool.handler(ctx(asker().message), {})).toBe('watch_video needs a question: what should the video answer?');
    expect(await tool.handler(ctx(asker({ channelMessages: [] }).message), { question: 'who?' })).toMatch(
      /^No video in the recent messages here/,
    );
    expect(await tool.handler(ctx(asker().message), { question: 'who?', message_or_url: 'the funny one' })).toMatch(
      /^message_or_url must be/,
    );
    expect(watched).toEqual([]);
  });

  it('caps watches per turn', async () => {
    const { tool, watched } = setup();
    const context = ctx(videoPost('900000000000000100'));
    for (let i = 0; i < 3; i++) await tool.handler(context, { question: `q${i}` });
    expect(await tool.handler(context, { question: 'one more' })).toMatch(/^Already watched 3 videos this turn/);
    expect(watched).toHaveLength(3);
  });

  it('only fetches the replied-to message when the current one has no video', async () => {
    const { tool } = setup();
    const fetchSpy = vi.fn();
    const message = videoPost('900000000000000100', CLIP, { referencedMessageId: '900000000000000050' });
    const original = message.channel.messages.fetch;
    message.channel.messages.fetch = ((arg: unknown) => {
      fetchSpy(arg);
      return original(arg as never);
    }) as typeof original;
    await tool.handler(ctx(message), { question: 'who?' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
