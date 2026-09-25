// The Discord side of auto-react: which new messages are candidates at all (intake), and what the judge
// is shown about one once its delay has passed (snapshot + context), read from the discord.js message
// object. discord.js patches a cached message in place on MESSAGE_UPDATE and on reaction events, so by
// the time the snapshot is taken the link embeds and reactions that arrived meanwhile are on it.
import type { Message } from 'discord.js';
import { formatLinkPreview } from '../ai/linkReader/format';
import { getLinkReader } from '../ai/linkReader/reader';
import { findLinks } from '../ai/linkReader/targets';
import { config } from '../config';
import { attributeMessage } from '../relay';
import type { Candidate, CandidateSnapshot } from './autoReactor';
import { readableEmojiText } from './guide';
import type { ContextLine } from './judge';

export type IntakeSettings = {
  channelIds: string[];
  /** Words that make a message a candidate for the gate (the bot's names): such a post gets a reply instead. */
  botNames: string[];
};

const MAX_EMBEDS = 3;
const MAX_LINK_PREVIEWS = 2;
const EMBED_CHARS = 300;
const LINK_PREVIEW_CHARS = 600;
// Context older than this before the post is a different conversation.
const CONTEXT_WINDOW_MS = 30 * 60 * 1000;
const BOT_LABEL = 'Frigidaire (the bot)';

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the text names the bot as a whole word ("fridge", "clanker", …). */
export function namesBot(text: string, names: string[]): boolean {
  if (!text) return false;
  return names.some((name) => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(trimmed)}($|[^\\p{L}\\p{N}_])`, 'iu').test(text);
  });
}

function channelMatches(message: Message, channelIds: string[]): boolean {
  if (channelIds.includes(message.channel.id)) return true;
  const parentId = message.channel.isThread() ? message.channel.parentId : null;
  return parentId !== null && channelIds.includes(parentId);
}

function hasSubstance(message: Message): boolean {
  return (
    message.content.trim().length > 0 ||
    message.attachments.size > 0 ||
    message.stickers.size > 0 ||
    message.embeds.length > 0 ||
    Boolean(message.poll)
  );
}

function isReplyToBot(message: Message, botId: string): boolean {
  if (message.mentions.repliedUser) return message.mentions.repliedUser.id === botId;
  const referenced = message.reference?.messageId;
  if (!referenced) return false;
  // Without a resolved author (the replied-to message is gone), the cache may still know it.
  return message.channel.messages.cache?.get(referenced)?.author.id === botId;
}

/**
 * Why a new message is not an auto-react candidate, or undefined when it is one. Posts addressed to the
 * bot (a mention, a reply to it, or its name, which the gate may answer) are skipped: those get a reply,
 * and the bot reacting on top of replying would be both.
 */
export function intakeSkipReason(message: Message, settings: IntakeSettings): string | undefined {
  if (!message.guildId) return 'not in a server';
  if (message.system) return 'system message';
  if (!channelMatches(message, settings.channelIds)) return 'channel not watched';
  const botId = message.client.user?.id;
  if (message.webhookId) {
    // Only the bot's own relays (link fixes, reposts) count: they are a member's post in the bot's hands.
    // Discord stamps the owning application on them; any other webhook is another integration.
    const ownApplicationId = message.client.application?.id ?? botId;
    if (!ownApplicationId || message.applicationId !== ownApplicationId) return 'foreign webhook';
  } else if (message.author.bot) {
    return message.author.id === botId ? 'own message' : 'bot';
  }
  if (botId && message.mentions.users.has(botId)) return 'mentions the bot';
  if (botId && isReplyToBot(message, botId)) return 'replies to the bot';
  if (namesBot(message.content, settings.botNames)) return 'names the bot';
  if (!hasSubstance(message)) return 'empty';
  return undefined;
}

function reactionLabel(emoji: { id: string | null; name: string | null }): string | undefined {
  if (emoji.id) return emoji.name ? `:${emoji.name}:` : undefined;
  return emoji.name ?? undefined;
}

function attachmentKind(contentType: string | null, name: string): string {
  const type = contentType ?? '';
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif)$/i.test(name)) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'file';
}

/** What the judge is shown about the post; undefined when it isn't a member's post (see attributeMessage). */
export function snapshotOf(message: Message): CandidateSnapshot | undefined {
  const attribution = attributeMessage(message);
  if (!attribution) return undefined;

  const notes: string[] = [];
  const imageUrls: string[] = [];

  for (const attachment of message.attachments.values()) {
    const kind = attachmentKind(attachment.contentType, attachment.name);
    if (kind === 'image') imageUrls.push(attachment.proxyURL || attachment.url);
    notes.push(`[${kind} attached: ${clip(attachment.name, 80)}]`);
  }
  for (const sticker of message.stickers.values()) notes.push(`[sticker: ${sticker.name}]`);
  if (message.poll) notes.push(`[poll: ${clip(message.poll.question.text ?? '', 200)}]`);
  for (const snapshot of message.messageSnapshots?.values() ?? []) {
    if (snapshot.content) notes.push(`[forwarded message: ${clip(readableEmojiText(snapshot.content), 300)}]`);
  }

  // Link previews the link reader already has (it reads links when the bot is asked about them), then
  // Discord's own embeds for the rest. Nothing is fetched here: a post nobody asked about costs nothing.
  const previewed = new Set<string>();
  if (config.linkReader.enabled) {
    const reader = getLinkReader();
    for (const url of findLinks(message.content).slice(0, MAX_LINK_PREVIEWS)) {
      const cached = reader.peek(url);
      if (!cached?.ok) continue;
      notes.push(clip(formatLinkPreview(url, cached), LINK_PREVIEW_CHARS));
      const key = reader.keyFor(url);
      if (key) previewed.add(key);
    }
  }
  for (const embed of message.embeds.slice(0, MAX_EMBEDS)) {
    const image = embed.image?.proxyURL ?? embed.thumbnail?.proxyURL ?? embed.image?.url ?? embed.thumbnail?.url;
    if (image) imageUrls.push(image);
    const key = embed.url && config.linkReader.enabled ? getLinkReader().keyFor(embed.url) : undefined;
    if (key && previewed.has(key)) continue;
    const text = [embed.author?.name, embed.title, embed.description].filter(Boolean).join(' — ');
    if (text) notes.push(`[link preview: ${clip(readableEmojiText(text), EMBED_CHARS)}]`);
  }

  let botReacted = false;
  const reactions: string[] = [];
  for (const reaction of message.reactions.cache.values()) {
    if (reaction.me) botReacted = true;
    const members = (reaction.count ?? 0) - (reaction.me ? 1 : 0);
    const label = reactionLabel(reaction.emoji);
    if (label && members > 0) reactions.push(`${label}×${members}`);
  }
  if (reactions.length > 0) notes.push(`[reactions so far: ${reactions.join(' ')}]`);

  return {
    authorId: attribution.authorId,
    authorName: attribution.authorName,
    text: readableEmojiText(message.content),
    notes,
    imageUrls,
    botReacted,
  };
}

/** The messages right before the post, from the channel's message cache (no API call), oldest first. */
export function contextOf(message: Message, limit: number): ContextLine[] {
  const cache = message.channel.messages.cache;
  if (!cache || limit <= 0) return [];
  const botId = message.client.user?.id;
  const earliest = message.createdTimestamp - CONTEXT_WINDOW_MS;
  const earlier = [...cache.values()]
    .filter(
      (m) => m.id !== message.id && m.createdTimestamp <= message.createdTimestamp && m.createdTimestamp >= earliest,
    )
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(-limit * 2);
  const lines: ContextLine[] = [];
  for (const m of earlier) {
    const isBot = !m.webhookId && m.author.id === botId;
    const author = isBot ? BOT_LABEL : attributeMessage(m)?.authorName;
    if (!author) continue;
    const extras = [...m.attachments.values()].map((a) => `[${attachmentKind(a.contentType, a.name)}]`);
    lines.push({ author, text: [readableEmojiText(m.content), ...extras].filter(Boolean).join(' ') });
  }
  return lines.slice(-limit);
}

export function discordCandidate(message: Message): Candidate {
  return {
    id: message.id,
    channelId: message.channel.id,
    url: message.url,
    createdAt: message.createdTimestamp,
    snapshot: () => snapshotOf(message),
    context: (limit) => contextOf(message, limit),
    react: async (emoji) => {
      await message.react(emoji);
    },
  };
}
