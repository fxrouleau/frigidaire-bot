import { ChannelType } from 'discord.js';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JudgeInput } from './ai/messageJudge';
import { DeletedMessageReposter } from './deletedMessages';
import { getRelay } from './relay';
import { BotDb, setBotDbForTesting } from './storage/botDb';
import { createFakeMessage } from './test-support/fakeDiscord';
import type { sendViaWebhook } from './utils';

const JASPER = 'jasper-id';
const T0 = 1_000_000;

type SendCall = Parameters<typeof sendViaWebhook>;

function makeReposter(opts: {
  verdict?: boolean | undefined;
  mode?: 'edgy' | 'always';
  attachmentBytes?: Buffer | undefined;
  now?: () => number;
} = {}) {
  const judgeCalls: JudgeInput[] = [];
  const sendCalls: SendCall[] = [];
  const reposter = new DeletedMessageReposter({
    userIds: () => [JASPER],
    windowMs: () => 60_000,
    mode: () => opts.mode ?? 'edgy',
    judge: async (input) => {
      judgeCalls.push(input);
      return 'verdict' in opts ? opts.verdict : true;
    },
    fetchAttachment: async () => opts.attachmentBytes,
    send: (async (...args: SendCall) => {
      sendCalls.push(args);
      return args[2].map((_, index) => ({ id: `repost-${sendCalls.length}-${index}` }));
    }) as unknown as typeof sendViaWebhook,
    now: opts.now ?? (() => T0),
  });
  return { reposter, judgeCalls, sendCalls };
}

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
    expect(judgeCalls).toEqual([{ author: 'Jasper', text: 'something edgy', imageUrls: [], attachmentNames: [] }]);
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
    expect(judgeCalls[0]).toEqual({ author: 'Jasper', text: 'something edgy', imageUrls: [], attachmentNames: ['odd.png'] });
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
