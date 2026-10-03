import { ChannelType } from 'discord.js';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JudgeInput } from './ai/messageJudge';
import { describeForJudge, type JudgeMediaDeps } from './deletedMessageMedia';
import { DeletedMessageReposter } from './deletedMessages';
import { getRelay } from './relay';
import { BotDb, setBotDbForTesting } from './storage/botDb';
import { createFakeMessage } from './test-support/fakeDiscord';
import type { sendViaWebhook } from './utils';

const JASPER = 'jasper-id';
const T0 = 1_000_000;

type SendCall = Parameters<typeof sendViaWebhook>;

/** The judge's view of a message's media, offline: no link reads, downloads, ffmpeg or transcription by default. */
const OFFLINE_MEDIA: JudgeMediaDeps = {
  readLink: async (url) => ({ ok: false, url, error: 'offline' }),
  downloadImage: async () => undefined,
  sampleVideo: async () => {
    throw new Error('no ffmpeg in this test');
  },
  transcribe: async () => undefined,
};

function makeReposter(opts: {
  verdict?: boolean | undefined;
  mode?: 'edgy' | 'always';
  attachmentBytes?: Buffer | undefined;
  media?: Partial<JudgeMediaDeps>;
  shrink?: (data: Buffer) => Promise<Buffer | undefined>;
  now?: () => number;
} = {}) {
  const judgeCalls: JudgeInput[] = [];
  const sendCalls: SendCall[] = [];
  const fetchCalls: Array<{ url: string; maxBytes: number }> = [];
  const shrinkCalls: Buffer[] = [];
  const reposter = new DeletedMessageReposter({
    userIds: () => [JASPER],
    windowMs: () => 60_000,
    mode: () => opts.mode ?? 'edgy',
    judge: async (input) => {
      judgeCalls.push(input);
      return 'verdict' in opts ? opts.verdict : true;
    },
    judgeMedia: (content, attachments) => describeForJudge(content, attachments, { ...OFFLINE_MEDIA, ...opts.media }),
    fetchAttachment: async (url, maxBytes) => {
      fetchCalls.push({ url, maxBytes });
      return opts.attachmentBytes;
    },
    shrinkVideo: async (data) => {
      shrinkCalls.push(data);
      return opts.shrink ? opts.shrink(data) : undefined;
    },
    send: (async (...args: SendCall) => {
      sendCalls.push(args);
      return args[2].map((_, index) => ({ id: `repost-${sendCalls.length}-${index}` }));
    }) as unknown as typeof sendViaWebhook,
    now: opts.now ?? (() => T0),
  });
  return { reposter, judgeCalls, sendCalls, fetchCalls, shrinkCalls };
}

const MB = 1024 * 1024;

function jasperMessage(overrides: Parameters<typeof createFakeMessage>[0] = {}) {
  return createFakeMessage({
    authorId: JASPER,
    authorDisplayName: 'Jasper',
    messageId: 'm1',
    content: 'something edgy',
    createdAt: new Date(T0),
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  setBotDbForTesting(undefined);
});

describe('DeletedMessageReposter', () => {
  it('reposts a watched user\'s quickly deleted edgy message as them', async () => {
    const { reposter, judgeCalls, sendCalls } = makeReposter({ now: () => T0 + 10_000 });
    const fake = jasperMessage();

    reposter.observe(fake.message);
    const outcome = await reposter.handleDelete(fake.message);

    expect(outcome).toBe('reposted');
    expect(judgeCalls).toEqual([
      { author: 'Jasper', text: 'something edgy', imageUrls: [], attachmentNames: [], mediaNotes: [] },
    ]);
    expect(sendCalls).toHaveLength(1);
    const [channel, identity, payload] = sendCalls[0];
    expect(channel.id).toBe('channel-1');
    expect(identity).toEqual({ name: 'Jasper', avatar: 'https://cdn.example/avatar.png' });
    // Never pings again: the original already did.
    expect(payload).toEqual([{ content: 'something edgy', allowedMentions: { parse: [] } }]);
  });

  it("watches a member's linked side account too, and reposts it as that account", async () => {
    const MAIN = '100000000000000001';
    const SIDE = '100000000000000002';
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${MAIN}`);
    const sendCalls: SendCall[] = [];
    const reposter = new DeletedMessageReposter({
      userIds: () => [MAIN],
      windowMs: () => 60_000,
      mode: () => 'always',
      fetchAttachment: async () => undefined,
      send: (async (...args: SendCall) => {
        sendCalls.push(args);
        return [{ id: 'repost-1' }];
      }) as unknown as typeof sendViaWebhook,
      now: () => T0 + 10_000,
    });
    const fake = jasperMessage({ authorId: SIDE, authorDisplayName: 'Jasper Alt', messageId: 'm-alt' });

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('reposted');
    expect(sendCalls[0][1]).toMatchObject({ name: 'Jasper Alt' });

    // Listing the side account instead watches the main account as well.
    const sideListed = new DeletedMessageReposter({ userIds: () => [SIDE], judge: async () => undefined });
    expect(sideListed.isWatched(MAIN)).toBe(true);
    expect(sideListed.isWatched('100000000000000003')).toBe(false);
  });

  it('ignores deletions by users who are not watched', async () => {
    const { reposter, sendCalls } = makeReposter();
    const fake = createFakeMessage({ authorId: 'someone-else', content: 'edgy', createdAt: new Date(T0) });

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('ignored');
    expect(sendCalls).toHaveLength(0);
  });

  it('ignores messages it never saw (posted before the bot started, or already expired)', async () => {
    const { reposter } = makeReposter();
    expect(await reposter.handleDelete(jasperMessage().message)).toBe('ignored');
  });

  it('does not repost when the judge says the message was not edgy', async () => {
    const { reposter, sendCalls } = makeReposter({ verdict: false });
    const fake = jasperMessage();

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('not-edgy');
    expect(sendCalls).toHaveLength(0);
  });

  it('fails closed (no repost) when the judge cannot decide', async () => {
    const { reposter, sendCalls } = makeReposter({ verdict: undefined });
    const fake = jasperMessage();

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('undecided');
    expect(sendCalls).toHaveLength(0);
  });

  it('skips the judge entirely in "always" mode', async () => {
    const { reposter, judgeCalls, sendCalls } = makeReposter({ mode: 'always', verdict: false });
    const fake = jasperMessage();

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('reposted');
    expect(judgeCalls).toHaveLength(0);
    expect(sendCalls).toHaveLength(1);
  });

  it('lets a deletion outside the window go (that is a real cleanup, not a regret)', async () => {
    let now = T0;
    const { reposter, sendCalls } = makeReposter({ now: () => now });
    const fake = jasperMessage();

    reposter.observe(fake.message);
    now = T0 + 61_000;
    expect(await reposter.handleDelete(fake.message)).toBe('expired');
    expect(sendCalls).toHaveLength(0);
  });

  it('does not react to a deletion the bot itself performed (link repost)', async () => {
    const { reposter, sendCalls } = makeReposter();
    const fake = jasperMessage();

    reposter.observe(fake.message);
    reposter.forget(fake.message.id);
    expect(await reposter.handleDelete(fake.message)).toBe('ignored');
    expect(sendCalls).toHaveLength(0);
  });

  it('never snapshots bot or webhook messages (its own reposts included)', () => {
    const { reposter } = makeReposter();
    reposter.observe(createFakeMessage({ authorId: JASPER, authorIsBot: true, content: 'x' }).message);
    reposter.observe(createFakeMessage({ authorId: JASPER, webhookId: 'wh-1', content: 'x' }).message);
    expect(reposter.size).toBe(0);
  });

  it('never snapshots messages from channels that cannot own a webhook', () => {
    const { reposter } = makeReposter();
    reposter.observe(jasperMessage({ channelType: ChannelType.PublicThread }).message);
    expect(reposter.size).toBe(0);
  });

  it('re-uploads attachments captured at post time and shows the judge the saved image, not the dead CDN url', async () => {
    const bytes = await sharp({ create: { width: 1200, height: 600, channels: 4, background: '#ff000080' } })
      .png()
      .toBuffer();
    const { reposter, judgeCalls, sendCalls } = makeReposter({ attachmentBytes: bytes });
    const fake = jasperMessage({
      content: '',
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/spicy.png', contentType: 'image/png', name: 'spicy.png' }],
    });

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('reposted');

    expect(judgeCalls[0]).toMatchObject({ author: 'Jasper', text: '', attachmentNames: ['spicy.png'] });
    const [image] = judgeCalls[0].imageUrls;
    expect(judgeCalls[0].imageUrls).toHaveLength(1);
    expect(image.startsWith('data:image/jpeg;base64,')).toBe(true);
    // Downscaled for the judge.
    const shown = await sharp(Buffer.from(image.slice('data:image/jpeg;base64,'.length), 'base64')).metadata();
    expect([shown.width, shown.height]).toEqual([768, 384]);
    const [, , payload] = sendCalls[0];
    expect(payload).toEqual([{ files: [{ attachment: bytes, name: 'spicy.png' }], allowedMentions: { parse: [] } }]);
  });

  it("judges a GIF from Discord's picker by what it shows, and reposts the link (Discord embeds it again)", async () => {
    const still = await sharp({ create: { width: 498, height: 280, channels: 3, background: '#336699' } })
      .png()
      .toBuffer();
    const gifUrl = 'https://klipy.com/gifs/some-reaction';
    const { reposter, judgeCalls, sendCalls } = makeReposter({
      media: {
        readLink: async (url) => ({
          ok: true,
          content: {
            url,
            source: 'klipy',
            kind: 'gif',
            title: 'Some Reaction',
            site: 'Klipy',
            text: 'tags: reaction',
            textTruncated: false,
            media: [{ type: 'image', url: 'https://static.klipy.com/still.webp' }],
          },
        }),
        downloadImage: async () => still,
      },
    });
    const fake = jasperMessage({ content: gifUrl });

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('reposted');

    expect(judgeCalls[0]).toMatchObject({ text: gifUrl, mediaNotes: ['gif on Klipy "Some Reaction": tags: reaction'] });
    expect(judgeCalls[0].imageUrls).toHaveLength(1);
    expect(sendCalls[0][2]).toEqual([{ content: gifUrl, allowedMentions: { parse: [] } }]);
  });

  it("judges a saved video by its keyframes and soundtrack, and re-uploads it", async () => {
    const bytes = Buffer.from('mp4-bytes');
    const { reposter, judgeCalls, sendCalls } = makeReposter({
      attachmentBytes: bytes,
      media: {
        sampleVideo: async (input) => {
          expect(input).toBe(bytes);
          return { durationSecs: 9, frames: [Buffer.from('frame')], audio: Buffer.from('mp3') };
        },
        transcribe: async () => 'something unrepeatable',
      },
    });
    const fake = jasperMessage({
      content: '',
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', contentType: 'video/mp4', name: 'clip.mp4' }],
    });

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('reposted');

    expect(judgeCalls[0]).toEqual({
      author: 'Jasper',
      text: '',
      imageUrls: [`data:image/jpeg;base64,${Buffer.from('frame').toString('base64')}`],
      attachmentNames: ['clip.mp4'],
      mediaNotes: ['video clip.mp4 (0:09), said: "something unrepeatable"'],
    });
    expect(sendCalls[0][2]).toEqual([{ files: [{ attachment: bytes, name: 'clip.mp4' }], allowedMentions: { parse: [] } }]);
  });

  it('looks at nothing in "always" mode: every qualifying deletion is reposted as is', async () => {
    let looked = false;
    const { reposter, sendCalls } = makeReposter({
      mode: 'always',
      media: {
        readLink: async (url) => {
          looked = true;
          return { ok: false, url, error: 'offline' };
        },
      },
    });
    const fake = jasperMessage({ content: 'https://klipy.com/gifs/some-reaction' });

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('reposted');
    expect(looked).toBe(false);
    expect(sendCalls).toHaveLength(1);
  });

  it('saves a video too big to upload, and reposts it shrunk under the limit as an .mp4', async () => {
    const original = Buffer.alloc(11 * MB, 1);
    const shrunk = Buffer.from('shrunk-mp4');
    const sampled: Buffer[] = [];
    const { reposter, sendCalls, fetchCalls, shrinkCalls } = makeReposter({
      attachmentBytes: original,
      shrink: async () => shrunk,
      media: {
        sampleVideo: async (input) => {
          sampled.push(input);
          return { durationSecs: 40, frames: [Buffer.from('frame')] };
        },
      },
    });
    const fake = jasperMessage({
      content: 'oops',
      attachments: [
        { url: 'https://cdn.discordapp.com/attachments/1/2/IMG_0042.MOV', contentType: 'video/quicktime', name: 'IMG_0042.MOV', size: 40 * MB },
      ],
    });

    reposter.observe(fake.message);
    expect(fetchCalls).toEqual([{ url: 'https://cdn.discordapp.com/attachments/1/2/IMG_0042.MOV', maxBytes: 100 * MB }]);
    expect(reposter.heldBytes).toBe(40 * MB);
    expect(await reposter.handleDelete(fake.message)).toBe('reposted');

    // The judge watched the original; only the repost is shrunk. (Identity checks: deep-comparing 11 MB is slow.)
    expect(sampled).toHaveLength(1);
    expect(sampled[0]).toBe(original);
    expect(shrinkCalls).toHaveLength(1);
    expect(shrinkCalls[0]).toBe(original);
    expect(sendCalls[0][2]).toEqual([
      { content: 'oops', allowedMentions: { parse: [] }, files: [{ attachment: shrunk, name: 'IMG_0042.mp4' }] },
    ]);
    expect(reposter.heldBytes).toBe(0);
  });

  it("leaves out a video it can't shrink, and posts nothing when the video was the whole message", async () => {
    const big = Buffer.alloc(11 * MB, 1);
    const video = { url: 'https://cdn.discordapp.com/attachments/1/2/long.mp4', contentType: 'video/mp4', name: 'long.mp4', size: 60 * MB };
    const failing = makeReposter({ attachmentBytes: big, shrink: async () => undefined });
    const alone = jasperMessage({ content: '', attachments: [video] });
    failing.reposter.observe(alone.message);
    expect(await failing.reposter.handleDelete(alone.message)).toBe('empty');
    expect(failing.sendCalls).toHaveLength(0);

    const crashing = makeReposter({
      attachmentBytes: big,
      shrink: async () => {
        throw new Error('ffmpeg timed out');
      },
    });
    const captioned = jasperMessage({ content: 'caption', attachments: [video] });
    crashing.reposter.observe(captioned.message);
    expect(await crashing.reposter.handleDelete(captioned.message)).toBe('reposted');
    expect(crashing.sendCalls[0][2]).toEqual([{ content: 'caption', allowedMentions: { parse: [] } }]);
  });

  it('never downloads what could not be reposted: a picture over the limit, a video over 100 MB', async () => {
    const { reposter, sendCalls, fetchCalls } = makeReposter({ mode: 'always', attachmentBytes: Buffer.from('x') });
    const fake = jasperMessage({
      attachments: [
        { url: 'https://cdn.discordapp.com/attachments/1/2/huge.png', contentType: 'image/png', name: 'huge.png', size: 12 * MB },
        { url: 'https://cdn.discordapp.com/attachments/1/2/movie.mp4', contentType: 'video/mp4', name: 'movie.mp4', size: 150 * MB },
      ],
    });

    reposter.observe(fake.message);
    expect(fetchCalls).toEqual([]);
    expect(reposter.heldBytes).toBe(0);
    expect(await reposter.handleDelete(fake.message)).toBe('reposted');
    expect(sendCalls[0][2]).toEqual([{ content: 'something edgy', allowedMentions: { parse: [] } }]);
  });

  it('holds at most 300 MB of big videos at once, and frees them as snapshots go', async () => {
    let now = T0;
    const { reposter, fetchCalls } = makeReposter({ now: () => now, attachmentBytes: Buffer.from('x') });
    const post = (id: string) => {
      const fake = jasperMessage({
        messageId: id,
        createdAt: new Date(now),
        attachments: [{ url: `https://cdn.discordapp.com/attachments/1/2/${id}.mp4`, contentType: 'video/mp4', name: `${id}.mp4`, size: 90 * MB }],
      });
      reposter.observe(fake.message);
      return fake.message;
    };

    const first = post('v1');
    post('v2');
    const third = post('v3');
    post('v4');
    expect(fetchCalls.map((c) => c.url.split('/').pop())).toEqual(['v1.mp4', 'v2.mp4', 'v3.mp4']);
    expect(reposter.heldBytes).toBe(270 * MB);

    // A deletion handled frees its video; so does the bot's own deletion.
    await reposter.handleDelete(first);
    reposter.forget(third.id);
    expect(reposter.heldBytes).toBe(90 * MB);
    post('v5');
    expect(fetchCalls).toHaveLength(4);

    // Snapshots past the window let theirs go too.
    now = T0 + 120_000;
    reposter.observe(jasperMessage({ messageId: 'later', createdAt: new Date(now) }).message);
    expect(reposter.heldBytes).toBe(0);
  });

  it('still reposts the text when an attachment could not be downloaded', async () => {
    const { reposter, sendCalls } = makeReposter({ attachmentBytes: undefined });
    const fake = jasperMessage({
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/big.mp4', contentType: 'video/mp4', name: 'big.mp4' }],
    });

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('reposted');
    expect(sendCalls[0][2]).toEqual([{ content: 'something edgy', allowedMentions: { parse: [] } }]);
  });

  it('never re-pings anyone: @everyone, roles and users in a reposted regret stay inert', async () => {
    const { reposter, sendCalls } = makeReposter({ mode: 'always' });
    const fake = jasperMessage({ content: '@everyone <@&42> <@7> lol' });

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('reposted');
    expect(sendCalls[0][2]).toEqual([{ content: '@everyone <@&42> <@7> lol', allowedMentions: { parse: [] } }]);
  });

  it("reposts a Nitro-length regret in webhook-sized chunks, files on the last, each one recorded as theirs", async () => {
    setBotDbForTesting(new BotDb(':memory:'));
    const bytes = Buffer.from('png-bytes');
    const { reposter, sendCalls } = makeReposter({ mode: 'always', attachmentBytes: bytes });
    const content = `${'a'.repeat(1500)}\n${'b'.repeat(1500)}`;
    const fake = jasperMessage({
      content,
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/pic.png', contentType: 'image/png', name: 'pic.png' }],
    });

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('reposted');

    expect(sendCalls).toHaveLength(1);
    const payloads = sendCalls[0][2];
    expect(payloads).toEqual([
      { content: 'a'.repeat(1500), allowedMentions: { parse: [] } },
      { content: 'b'.repeat(1500), allowedMentions: { parse: [] }, files: [{ attachment: bytes, name: 'pic.png' }] },
    ]);
    expect(getRelay('repost-1-0')).toMatchObject({ authorId: JASPER, kind: 'regret', originalId: 'm1' });
    expect(getRelay('repost-1-1')).toMatchObject({ authorId: JASPER, kind: 'regret', originalId: 'm1' });
  });

  it('judges an image whose bytes could not be decoded (or saved) by its name alone', async () => {
    const { reposter, judgeCalls } = makeReposter({ attachmentBytes: Buffer.from('not an image') });
    const fake = jasperMessage({
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/odd.png', contentType: 'image/png', name: 'odd.png' }],
    });

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('reposted');
    expect(judgeCalls[0]).toEqual({
      author: 'Jasper',
      text: 'something edgy',
      imageUrls: [],
      attachmentNames: ['odd.png'],
      mediaNotes: [],
    });
  });

  it('does not pay the judge when nothing could be reposted anyway', async () => {
    const { reposter, judgeCalls, sendCalls } = makeReposter({ attachmentBytes: undefined });
    const fake = jasperMessage({
      content: '',
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/huge.png', contentType: 'image/png', name: 'huge.png' }],
    });

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('empty');
    expect(judgeCalls).toHaveLength(0);
    expect(sendCalls).toHaveLength(0);
  });

  it('reports "empty" when there is nothing left to repost', async () => {
    const { reposter, sendCalls } = makeReposter({ mode: 'always', attachmentBytes: undefined });
    const fake = jasperMessage({
      content: '',
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/gone.png', contentType: 'image/png' }],
    });

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('empty');
    expect(sendCalls).toHaveLength(0);
  });

  it('forgets snapshots once they are older than the window', () => {
    let now = T0;
    const { reposter } = makeReposter({ now: () => now });
    reposter.observe(jasperMessage({ messageId: 'old' }).message);

    now = T0 + 120_000;
    reposter.observe(jasperMessage({ messageId: 'new', createdAt: new Date(now) }).message);

    expect(reposter.size).toBe(1);
  });

  it('uses the server nickname as the webhook name when there is one', async () => {
    const { reposter, sendCalls } = makeReposter({ mode: 'always' });
    const fake = jasperMessage();
    (fake.message as unknown as { member: { nickname: string | null } }).member.nickname = 'Jay';

    reposter.observe(fake.message);
    await reposter.handleDelete(fake.message);

    expect(sendCalls[0][1].name).toBe('Jay');
  });

  vi.restoreAllMocks();
});
