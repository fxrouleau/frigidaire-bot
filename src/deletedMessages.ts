// "Post it, regret it, delete it" — and the bot puts it right back, as you.
//
// For the configured users (DELETE_REPOST_USER_IDS), every message they post in a webhook-capable
// channel is snapshotted for a short window (DELETE_REPOST_WINDOW_MS), attachments included: Discord
// gives a MessageDelete event only a partial message (and drops the attachment files), so the
// content has to be captured up front. When one of those messages is deleted inside the window, the
// judge decides whether it was one of their "edgy bouts" (DELETE_REPOST_MODE=edgy, the default) or
// every deletion qualifies (always), and the message is reposted through a webhook wearing the
// author's name and avatar. A watched member's side account (LINKED_ACCOUNTS) is watched too, and its
// messages are reposted as that account.
import type { Message, PartialMessage } from 'discord.js';
import { type MessageJudge, createEdgyJudge } from './ai/messageJudge';
import { type DeleteRepostMode, config } from './config';
import { isSamePerson } from './linkedAccounts';
import { logger } from './logger';
import { recordRelay } from './relay';
import { type WebhookIdentity, isWebhookCapableChannel, sendViaWebhook } from './utils';

const MAX_SNAPSHOTS = 100;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// Snapshots outlive the repost window by this much so a delete racing the window edge still resolves.
const SNAPSHOT_GRACE_MS = 5000;

export type SnapshotAttachment = { name: string; contentType: string | null; data: Buffer };

export type MessageSnapshot = {
  id: string;
  channelId: string;
  authorId: string;
  identity: WebhookIdentity;
  content: string;
  createdAt: number;
  imageUrls: string[];
  attachmentNames: string[];
  attachments: Promise<SnapshotAttachment[]>;
};

export type DeleteOutcome = 'ignored' | 'expired' | 'not-edgy' | 'undecided' | 'empty' | 'reposted';

export type DeletedMessageReposterOptions = {
  userIds?: () => string[];
  windowMs?: () => number;
  mode?: () => DeleteRepostMode;
  judge?: MessageJudge;
  fetchAttachment?: (url: string) => Promise<Buffer | undefined>;
  send?: typeof sendViaWebhook;
  now?: () => number;
};

async function downloadAttachment(url: string): Promise<Buffer | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return undefined;
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_ATTACHMENT_BYTES) return undefined;
    const data = Buffer.from(await response.arrayBuffer());
    return data.byteLength <= MAX_ATTACHMENT_BYTES ? data : undefined;
  } catch (error) {
    logger.warn(`deletedMessages: attachment download failed for ${url}:`, error);
    return undefined;
  }
}

export class DeletedMessageReposter {
  private readonly snapshots = new Map<string, MessageSnapshot>();
  private readonly botDeleted = new Set<string>();
  private readonly userIds: () => string[];
  private readonly windowMs: () => number;
  private readonly mode: () => DeleteRepostMode;
  private readonly judge: MessageJudge;
  private readonly fetchAttachment: (url: string) => Promise<Buffer | undefined>;
  private readonly send: typeof sendViaWebhook;
  private readonly now: () => number;

  constructor(opts: DeletedMessageReposterOptions = {}) {
    this.userIds = opts.userIds ?? (() => config.deleteRepost.userIds);
    this.windowMs = opts.windowMs ?? (() => config.deleteRepost.windowMs);
    this.mode = opts.mode ?? (() => config.deleteRepost.mode);
    this.judge = opts.judge ?? createEdgyJudge();
    this.fetchAttachment = opts.fetchAttachment ?? downloadAttachment;
    this.send = opts.send ?? sendViaWebhook;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Listing either of a member's accounts in DELETE_REPOST_USER_IDS watches both. */
  isWatched(userId: string): boolean {
    return this.userIds().some((id) => isSamePerson(id, userId));
  }

  /** Snapshots a freshly posted message when its author is watched. Cheap no-op for everyone else. */
  observe(message: Message): void {
    if (message.author.bot || message.webhookId) return;
    if (!this.isWatched(message.author.id)) return;
    if (!isWebhookCapableChannel(message.channel)) return;

    const now = this.now();
    this.prune(now);

    const attachments = [...message.attachments.values()];
    const imageUrls = attachments.filter((a) => a.contentType?.startsWith('image/')).map((a) => a.url);
    const downloads = Promise.all(
      attachments.map(async (a) => {
        const data = await this.fetchAttachment(a.url);
        return data ? { name: a.name, contentType: a.contentType, data } : undefined;
      }),
    ).then((results) => results.filter((r): r is SnapshotAttachment => r !== undefined));

    this.snapshots.set(message.id, {
      id: message.id,
      channelId: message.channel.id,
      authorId: message.author.id,
      identity: {
        name: message.member?.nickname || message.author.displayName,
        avatar: message.member?.displayAvatarURL({ forceStatic: true }),
      },
      content: message.content ?? '',
      createdAt: message.createdTimestamp ?? now,
      imageUrls,
      attachmentNames: attachments.map((a) => a.name),
      attachments: downloads,
    });
  }

  /** Tells the reposter the bot itself is about to delete this message (link fix), so it is not "a regret". */
  forget(messageId: string): void {
    this.snapshots.delete(messageId);
    this.botDeleted.add(messageId);
  }

  async handleDelete(message: Message | PartialMessage): Promise<DeleteOutcome> {
    if (this.botDeleted.delete(message.id)) return 'ignored';
    const snapshot = this.snapshots.get(message.id);
    if (!snapshot) return 'ignored';
    this.snapshots.delete(message.id);

    const age = this.now() - snapshot.createdAt;
    if (age > this.windowMs()) return 'expired';

    const channel = message.channel;
    if (!isWebhookCapableChannel(channel)) return 'ignored';

    if (this.mode() === 'edgy') {
      const verdict = await this.judge({
        author: snapshot.identity.name,
        text: snapshot.content,
        imageUrls: snapshot.imageUrls,
        attachmentNames: snapshot.attachmentNames,
      });
      if (verdict === undefined) {
        logger.warn(`deletedMessages: no verdict for ${snapshot.id}; leaving it deleted`);
        return 'undecided';
      }
      if (!verdict) return 'not-edgy';
    }

    const attachments = await snapshot.attachments;
    if (snapshot.content.length === 0 && attachments.length === 0) return 'empty';

    logger.info(`deletedMessages: reposting ${snapshot.id} by ${snapshot.identity.name} (deleted after ${age}ms)`);
    const repost = await this.send(channel, snapshot.identity, {
      content: snapshot.content.length > 0 ? snapshot.content : undefined,
      files: attachments.map((a) => ({ attachment: a.data, name: a.name })),
      // The original already pinged whoever it mentioned. And a webhook isn't bound by the author's
      // Mention Everyone permission, so parsing here could turn their @everyone into a real ping.
      allowedMentions: { parse: [] },
    });
    if (repost?.id) {
      recordRelay({
        messageId: repost.id,
        channelId: channel.id,
        authorId: snapshot.authorId,
        authorName: snapshot.identity.name,
        kind: 'regret',
        originalId: snapshot.id,
      });
    }
    return 'reposted';
  }

  /** Test-only: number of live snapshots. */
  get size(): number {
    return this.snapshots.size;
  }

  private prune(now: number): void {
    const maxAge = this.windowMs() + SNAPSHOT_GRACE_MS;
    for (const [id, snapshot] of this.snapshots) {
      if (now - snapshot.createdAt > maxAge) this.snapshots.delete(id);
    }
    while (this.snapshots.size >= MAX_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
  }
}

export const deletedMessageReposter = new DeletedMessageReposter();
