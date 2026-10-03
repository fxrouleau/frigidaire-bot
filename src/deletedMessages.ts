// "Post it, regret it, delete it" — and the bot puts it right back, as you.
//
// For the configured users (DELETE_REPOST_USER_IDS), every message they post in a webhook-capable
// channel is snapshotted for a short window (DELETE_REPOST_WINDOW_MS), attachments included: Discord
// gives a MessageDelete event only a partial message (and drops the attachment files), so the
// content has to be captured up front. When one of those messages is deleted inside the window, the
// judge decides whether it was one of their "edgy bouts" (DELETE_REPOST_MODE=edgy, the default) or
// every deletion qualifies (always), and the message is reposted through a webhook wearing the
// author's name and avatar. A watched member's side account (LINKED_ACCOUNTS) is watched too, and its
// messages are reposted as that account. The judge sees what the message showed, not just its text: its
// pictures, frames and the soundtrack of its videos, and the GIFs it linked (deletedMessageMedia.ts).
//
// A webhook can upload 10 MB per file (level-1 boosts don't raise it). Videos up to 100 MB are saved
// anyway, within a cap on what all snapshots hold at once, and one that gets reposted is first shrunk
// to fit (ffmpeg, getMediaTranscoder().shrinkVideo): a lower resolution and bitrate, for up to 5 minutes
// of footage. Shrinking only happens for a repost that is going out, never for a message nobody deleted.
import type { Message, PartialMessage, WebhookMessageCreateOptions } from 'discord.js';
import { getMediaTranscoder } from './ai/media';
import { downloadMedia } from './ai/media/download';
import { createEdgyJudge, type MessageJudge } from './ai/messageJudge';
import { config, type DeleteRepostMode } from './config';
import { attachmentKind, describeForJudge, type JudgeMedia, type SnapshotAttachment } from './deletedMessageMedia';
import { isSamePerson } from './linkedAccounts';
import { logger } from './logger';
import { recordRelay } from './relay';
import {
  isWebhookCapableChannel,
  MAX_WEBHOOK_CONTENT,
  sendViaWebhook,
  splitMessage,
  type WebhookIdentity,
} from './utils';

const MAX_SNAPSHOTS = 100;
// What a webhook can upload per file in a server without a level-2 boost.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// A bigger video is saved too, to be shrunk under the upload limit if it gets reposted.
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
// What all snapshots' big videos may hold at once (each lives for the repost window).
const MAX_HELD_VIDEO_BYTES = 300 * 1024 * 1024;
// The shrunk file's limit leaves room under the upload limit; past 5 minutes it would be mush.
const SHRINK_TARGET_BYTES = Math.floor(9.5 * 1024 * 1024);
const MAX_SHRINK_SECONDS = 300;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 60_000;
// Snapshots outlive the repost window by this much so a delete racing the window edge still resolves.
const SNAPSHOT_GRACE_MS = 5000;

export type { SnapshotAttachment };

export type MessageSnapshot = {
  id: string;
  channelId: string;
  authorId: string;
  identity: WebhookIdentity;
  content: string;
  createdAt: number;
  attachmentNames: string[];
  attachments: Promise<SnapshotAttachment[]>;
  /** Bytes of big videos this snapshot holds against MAX_HELD_VIDEO_BYTES (0 once released). */
  heldBytes: number;
};

export type DeleteOutcome = 'ignored' | 'expired' | 'not-edgy' | 'undecided' | 'empty' | 'reposted';

export type DeletedMessageReposterOptions = {
  userIds?: () => string[];
  windowMs?: () => number;
  mode?: () => DeleteRepostMode;
  judge?: MessageJudge;
  /** What the saved attachments and the text's GIF links show, for the judge. Default: describeForJudge. */
  judgeMedia?: (content: string, attachments: SnapshotAttachment[]) => Promise<JudgeMedia>;
  /** An attachment's bytes, refused past `maxBytes`. Default: downloadMedia (Discord's CDN, streamed and capped). */
  fetchAttachment?: (url: string, maxBytes: number) => Promise<Buffer | undefined>;
  /** A video re-encoded under the upload limit, or undefined when it can't be. Default: ffmpeg. */
  shrinkVideo?: (data: Buffer) => Promise<Buffer | undefined>;
  send?: typeof sendViaWebhook;
  now?: () => number;
};

async function downloadAttachment(url: string, maxBytes: number): Promise<Buffer | undefined> {
  const timeoutMs = maxBytes > MAX_ATTACHMENT_BYTES ? VIDEO_DOWNLOAD_TIMEOUT_MS : DOWNLOAD_TIMEOUT_MS;
  const result = await downloadMedia(url, { maxBytes, timeoutMs });
  return result.ok ? result.data : undefined;
}

async function shrinkWithFfmpeg(data: Buffer): Promise<Buffer | undefined> {
  const shrunk = await getMediaTranscoder().shrinkVideo(data, {
    maxBytes: SHRINK_TARGET_BYTES,
    maxSeconds: MAX_SHRINK_SECONDS,
  });
  return shrunk?.data;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** IMG_0042.MOV → IMG_0042.mp4 (a SPOILER_ prefix stays). */
function asMp4(name: string): string {
  return `${name.replace(/\.[^./\\]*$/, '')}.mp4`;
}

/**
 * The repost as webhook posts: the text in chunks a webhook can carry (a Nitro member's message can be
 * twice Discord's webhook limit), the attachments on the last one. Mentions never ping again: the
 * original already pinged, and a webhook would fire @everyone/role mentions the author may not even
 * be allowed to use.
 */
function regretPayloads(content: string, attachments: SnapshotAttachment[]): WebhookMessageCreateOptions[] {
  const payloads: WebhookMessageCreateOptions[] = (
    content.length > 0 ? splitMessage(content, MAX_WEBHOOK_CONTENT) : []
  ).map((chunk) => ({ content: chunk, allowedMentions: { parse: [] } }));
  if (attachments.length > 0) {
    const files = attachments.map((a) => ({ attachment: a.data, name: a.name }));
    const last = payloads.at(-1);
    if (last) last.files = files;
    else payloads.push({ files, allowedMentions: { parse: [] } });
  }
  return payloads;
}

export class DeletedMessageReposter {
  private readonly snapshots = new Map<string, MessageSnapshot>();
  private readonly botDeleted = new Set<string>();
  private readonly userIds: () => string[];
  private readonly windowMs: () => number;
  private readonly mode: () => DeleteRepostMode;
  private readonly judge: MessageJudge;
  private readonly judgeMedia: (content: string, attachments: SnapshotAttachment[]) => Promise<JudgeMedia>;
  private readonly fetchAttachment: (url: string, maxBytes: number) => Promise<Buffer | undefined>;
  private readonly shrinkVideo: (data: Buffer) => Promise<Buffer | undefined>;
  private readonly send: typeof sendViaWebhook;
  private readonly now: () => number;
  private heldVideoBytes = 0;

  constructor(opts: DeletedMessageReposterOptions = {}) {
    this.userIds = opts.userIds ?? (() => config.deleteRepost.userIds);
    this.windowMs = opts.windowMs ?? (() => config.deleteRepost.windowMs);
    this.mode = opts.mode ?? (() => config.deleteRepost.mode);
    this.judge = opts.judge ?? createEdgyJudge();
    this.judgeMedia = opts.judgeMedia ?? ((content, attachments) => describeForJudge(content, attachments));
    this.fetchAttachment = opts.fetchAttachment ?? downloadAttachment;
    this.shrinkVideo = opts.shrinkVideo ?? shrinkWithFfmpeg;
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
    let heldBytes = 0;
    const limits = attachments.map((a) => {
      if (a.size <= MAX_ATTACHMENT_BYTES) return MAX_ATTACHMENT_BYTES;
      // Too big to repost: only a video can be brought under the upload limit.
      if (attachmentKind(a) !== 'video' || a.size > MAX_VIDEO_BYTES) return 0;
      if (this.heldVideoBytes + a.size > MAX_HELD_VIDEO_BYTES) {
        logger.info(
          `deletedMessages: not saving ${a.name} (${megabytes(a.size)}): ${megabytes(this.heldVideoBytes)} of videos already held`,
        );
        return 0;
      }
      this.heldVideoBytes += a.size;
      heldBytes += a.size;
      return MAX_VIDEO_BYTES;
    });
    const downloads = Promise.all(
      attachments.map(async (a, index) => {
        if (limits[index] === 0) return undefined;
        const data = await this.fetchAttachment(a.url, limits[index]);
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
      attachmentNames: attachments.map((a) => a.name),
      attachments: downloads,
      heldBytes,
    });
  }

  /** Tells the reposter the bot itself is about to delete this message (link fix), so it is not "a regret". */
  forget(messageId: string): void {
    const snapshot = this.snapshots.get(messageId);
    if (snapshot) this.drop(snapshot);
    this.botDeleted.add(messageId);
  }

  async handleDelete(message: Message | PartialMessage): Promise<DeleteOutcome> {
    if (this.botDeleted.delete(message.id)) return 'ignored';
    const snapshot = this.snapshots.get(message.id);
    if (!snapshot) return 'ignored';
    this.snapshots.delete(message.id);
    try {
      return await this.resolve(snapshot, message);
    } finally {
      this.release(snapshot);
    }
  }

  private async resolve(snapshot: MessageSnapshot, message: Message | PartialMessage): Promise<DeleteOutcome> {
    const age = this.now() - snapshot.createdAt;
    if (age > this.windowMs()) return 'expired';

    const channel = message.channel;
    if (!isWebhookCapableChannel(channel)) return 'ignored';

    // Awaited before judging: the judge sees the bytes saved at post time, because the deleted
    // message's CDN URLs stop serving its files. And nothing left to repost means nothing to pay a judge for.
    const attachments = await snapshot.attachments;
    if (snapshot.content.length === 0 && attachments.length === 0) return 'empty';

    if (this.mode() === 'edgy') {
      const media = await this.judgeMedia(snapshot.content, attachments);
      if (media.imageUrls.length > 0 || media.notes.length > 0) {
        logger.info(
          `deletedMessages: judging ${snapshot.id} with ${media.imageUrls.length} image(s) and ${media.notes.length} media note(s)`,
        );
      }
      const verdict = await this.judge({
        author: snapshot.identity.name,
        text: snapshot.content,
        imageUrls: media.imageUrls,
        attachmentNames: snapshot.attachmentNames,
        mediaNotes: media.notes,
      });
      if (verdict === undefined) {
        logger.warn(`deletedMessages: no verdict for ${snapshot.id}; leaving it deleted`);
        return 'undecided';
      }
      if (!verdict) return 'not-edgy';
    }

    const files = await this.fitForUpload(attachments);
    if (snapshot.content.length === 0 && files.length === 0) return 'empty';

    logger.info(`deletedMessages: reposting ${snapshot.id} by ${snapshot.identity.name} (deleted after ${age}ms)`);
    const reposts = await this.send(channel, snapshot.identity, regretPayloads(snapshot.content, files));
    for (const repost of reposts) {
      if (!repost?.id) continue;
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

  /** Test-only: bytes of big videos the live snapshots hold. */
  get heldBytes(): number {
    return this.heldVideoBytes;
  }

  /** The attachments as a webhook can upload them: big videos shrunk, what can't be shrunk left out. */
  private async fitForUpload(attachments: SnapshotAttachment[]): Promise<SnapshotAttachment[]> {
    const fitted = await Promise.all(
      attachments.map(async (attachment): Promise<SnapshotAttachment | undefined> => {
        if (attachment.data.byteLength <= MAX_ATTACHMENT_BYTES) return attachment;
        const size = megabytes(attachment.data.byteLength);
        try {
          const data = await this.shrinkVideo(attachment.data);
          if (!data) {
            logger.info(`deletedMessages: ${attachment.name} (${size}) can't be shrunk to fit; left out of the repost`);
            return undefined;
          }
          logger.info(`deletedMessages: shrank ${attachment.name} from ${size} to ${megabytes(data.byteLength)}`);
          return { name: asMp4(attachment.name), contentType: 'video/mp4', data };
        } catch (error) {
          logger.warn(`deletedMessages: shrinking ${attachment.name} (${size}) failed; left out of the repost:`, error);
          return undefined;
        }
      }),
    );
    return fitted.filter((a): a is SnapshotAttachment => a !== undefined);
  }

  private drop(snapshot: MessageSnapshot): void {
    this.snapshots.delete(snapshot.id);
    this.release(snapshot);
  }

  private release(snapshot: MessageSnapshot): void {
    this.heldVideoBytes -= snapshot.heldBytes;
    snapshot.heldBytes = 0;
  }

  private prune(now: number): void {
    const maxAge = this.windowMs() + SNAPSHOT_GRACE_MS;
    for (const snapshot of [...this.snapshots.values()]) {
      if (now - snapshot.createdAt > maxAge) this.drop(snapshot);
    }
    while (this.snapshots.size >= MAX_SNAPSHOTS) {
      const oldest = this.snapshots.values().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }
}

export const deletedMessageReposter = new DeletedMessageReposter();
