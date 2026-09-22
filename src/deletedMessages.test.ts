import { ChannelType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { JudgeInput } from './ai/messageJudge';
import { DeletedMessageReposter } from './deletedMessages';
import { createFakeMessage } from './test-support/fakeDiscord';
import type { sendViaWebhook } from './utils';

const JASON = 'jason-id';
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
    userIds: () => [JASON],
    windowMs: () => 60_000,
    mode: () => opts.mode ?? 'edgy',
    judge: async (input) => {
      judgeCalls.push(input);
      return 'verdict' in opts ? opts.verdict : true;
    },
    fetchAttachment: async () => opts.attachmentBytes,
    send: (async (...args: SendCall) => {
      sendCalls.push(args);
    }) as typeof sendViaWebhook,
    now: opts.now ?? (() => T0),
  });
  return { reposter, judgeCalls, sendCalls };
}

function jasonMessage(overrides: Parameters<typeof createFakeMessage>[0] = {}) {
  return createFakeMessage({
    authorId: JASON,
    authorDisplayName: 'Jason',
    messageId: 'm1',
    content: 'something edgy',
    createdAt: new Date(T0),
    ...overrides,
  });
}

describe('DeletedMessageReposter', () => {
  it('reposts a watched user\'s quickly deleted edgy message as them', async () => {
    const { reposter, judgeCalls, sendCalls } = makeReposter({ now: () => T0 + 10_000 });
    const fake = jasonMessage();

    reposter.observe(fake.message);
    const outcome = await reposter.handleDelete(fake.message);

    expect(outcome).toBe('reposted');
    expect(judgeCalls).toEqual([{ author: 'Jason', text: 'something edgy', imageUrls: [], attachmentNames: [] }]);
    expect(sendCalls).toHaveLength(1);
    const [channel, identity, payload] = sendCalls[0];
    expect(channel.id).toBe('channel-1');
    expect(identity).toEqual({ name: 'Jason', avatar: 'https://cdn.example/avatar.png' });
    expect(payload).toEqual({ content: 'something edgy', files: [] });
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
    expect(await reposter.handleDelete(jasonMessage().message)).toBe('ignored');
  });

  it('does not repost when the judge says the message was not edgy', async () => {
    const { reposter, sendCalls } = makeReposter({ verdict: false });
    const fake = jasonMessage();

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('not-edgy');
    expect(sendCalls).toHaveLength(0);
  });

  it('fails closed (no repost) when the judge cannot decide', async () => {
    const { reposter, sendCalls } = makeReposter({ verdict: undefined });
    const fake = jasonMessage();

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('undecided');
    expect(sendCalls).toHaveLength(0);
  });

  it('skips the judge entirely in "always" mode', async () => {
    const { reposter, judgeCalls, sendCalls } = makeReposter({ mode: 'always', verdict: false });
    const fake = jasonMessage();

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('reposted');
    expect(judgeCalls).toHaveLength(0);
    expect(sendCalls).toHaveLength(1);
  });

  it('lets a deletion outside the window go (that is a real cleanup, not a regret)', async () => {
    let now = T0;
    const { reposter, sendCalls } = makeReposter({ now: () => now });
    const fake = jasonMessage();

    reposter.observe(fake.message);
    now = T0 + 61_000;
    expect(await reposter.handleDelete(fake.message)).toBe('expired');
    expect(sendCalls).toHaveLength(0);
  });

  it('does not react to a deletion the bot itself performed (link repost)', async () => {
    const { reposter, sendCalls } = makeReposter();
    const fake = jasonMessage();

    reposter.observe(fake.message);
    reposter.forget(fake.message.id);
    expect(await reposter.handleDelete(fake.message)).toBe('ignored');
    expect(sendCalls).toHaveLength(0);
  });

  it('never snapshots bot or webhook messages (its own reposts included)', () => {
    const { reposter } = makeReposter();
    reposter.observe(createFakeMessage({ authorId: JASON, authorIsBot: true, content: 'x' }).message);
    reposter.observe(createFakeMessage({ authorId: JASON, webhookId: 'wh-1', content: 'x' }).message);
    expect(reposter.size).toBe(0);
  });

  it('never snapshots messages from channels that cannot own a webhook', () => {
    const { reposter } = makeReposter();
    reposter.observe(jasonMessage({ channelType: ChannelType.PublicThread }).message);
    expect(reposter.size).toBe(0);
  });

  it('re-uploads attachments captured at post time and tells the judge about images', async () => {
    const bytes = Buffer.from('png-bytes');
    const { reposter, judgeCalls, sendCalls } = makeReposter({ attachmentBytes: bytes });
    const fake = jasonMessage({
      content: '',
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/spicy.png', contentType: 'image/png', name: 'spicy.png' }],
    });

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('reposted');

    expect(judgeCalls[0]).toEqual({
      author: 'Jason',
      text: '',
      imageUrls: ['https://cdn.discordapp.com/attachments/1/2/spicy.png'],
      attachmentNames: ['spicy.png'],
    });
    const [, , payload] = sendCalls[0];
    expect(payload).toEqual({ content: undefined, files: [{ attachment: bytes, name: 'spicy.png' }] });
  });

  it('still reposts the text when an attachment could not be downloaded', async () => {
    const { reposter, sendCalls } = makeReposter({ attachmentBytes: undefined });
    const fake = jasonMessage({
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/big.mp4', contentType: 'video/mp4', name: 'big.mp4' }],
    });

    reposter.observe(fake.message);
    expect(await reposter.handleDelete(fake.message)).toBe('reposted');
    expect(sendCalls[0][2]).toEqual({ content: 'something edgy', files: [] });
  });

  it('reports "empty" when there is nothing left to repost', async () => {
    const { reposter, sendCalls } = makeReposter({ mode: 'always', attachmentBytes: undefined });
    const fake = jasonMessage({
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
    reposter.observe(jasonMessage({ messageId: 'old' }).message);

    now = T0 + 120_000;
    reposter.observe(jasonMessage({ messageId: 'new', createdAt: new Date(now) }).message);

    expect(reposter.size).toBe(1);
  });

  it('uses the server nickname as the webhook name when there is one', async () => {
    const { reposter, sendCalls } = makeReposter({ mode: 'always' });
    const fake = jasonMessage();
    (fake.message as unknown as { member: { nickname: string | null } }).member.nickname = 'Jay';

    reposter.observe(fake.message);
    await reposter.handleDelete(fake.message);

    expect(sendCalls[0][1].name).toBe('Jay');
  });

  vi.restoreAllMocks();
});
