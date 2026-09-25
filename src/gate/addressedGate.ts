// Replying without an @-mention: decides whether a message nobody pinged the bot in is still meant for
// it ("fridge who wins worlds", or "why tho" right after the bot answered that person).
//
// Order matters for cost: every check up to the rate limit is free and runs on every message in the
// gate's channels; only a candidate (its text names the bot, or its author is who the bot was just
// talking to) costs a REST fetch of a few messages of context plus one decision-model call (~$0.00001).
// The decision fails closed: no answer, or a probability under GATE_THRESHOLD, means no reply.
//
// Who the bot is talking to comes from watching its own messages here: Discord stamps a reply's target
// on `mentions.repliedUser`, and a routed turn whose reply had to fall back to a plain send is covered by
// the author recorded when the turn was routed. This state is in memory: after a restart the first
// candidate reads the same facts off the fetched history instead.
import type { Message } from 'discord.js';
import { getMemoryStore } from '../ai/memory';
import { config } from '../config';
import { logger } from '../logger';
import { attributeMessage } from '../relay';
import { type AddressedClassifier, type AddressedInput, type ChatLine, createAddressedClassifier } from './addressed';
import { createNameMatcher, isFollowup, readableMarkup, truncate } from './text';

const RATE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_CONTEXT_SIZE = 6;
// A routed turn's author stands in for the reply target only this long (a turn with tools can take a
// while, but a stale route must not make some later unrelated bot post look like a conversation).
const PENDING_PARTNER_TTL_MS = 5 * 60 * 1000;
const LOG_EXCERPT_CHARS = 80;

export type GateSettings = {
  enabled: boolean;
  channelIds: string[];
  names: string[];
  followupSeconds: number;
  maxPer10Min: number;
  threshold: number;
};

export function gateSettingsFromConfig(): GateSettings {
  const gate = config.gate;
  return {
    enabled: gate.enabled,
    channelIds: gate.channelIds,
    names: gate.names,
    followupSeconds: gate.followupSeconds,
    maxPer10Min: gate.maxPer10Min,
    threshold: gate.threshold,
  };
}

export type GateTrigger = 'name' | 'followup' | 'name+followup';

export type GateSkipReason =
  | 'disabled'
  | 'not_watched'
  | 'not_human'
  | 'no_trigger'
  | 'no_text'
  | 'rate_limited'
  | 'no_answer'
  | 'below_threshold';

export type GateVerdict =
  | { respond: true; trigger: GateTrigger; probability: number }
  | { respond: false; reason: GateSkipReason; trigger?: GateTrigger; probability?: number };

type ChannelActivity = {
  /** createdTimestamp of the bot's last message in the channel. */
  botSpokeAt?: number;
  /** Who that message was answering. */
  partnerId?: string;
  /** The author of the last turn routed to the agent here, until its reply shows up. */
  pending?: { userId: string; at: number };
  /** When the gate routed unsolicited replies here (for the rate limit). */
  unsolicitedAt: number[];
};

export type AddressedGateOptions = {
  classify?: AddressedClassifier;
  /** Read on every message (tests inject fixed settings; prod reads config). */
  settings?: () => GateSettings;
  now?: () => number;
  /** How many messages before the candidate the decision model sees. */
  contextSize?: number;
};

export class AddressedGate {
  private readonly classify: AddressedClassifier;
  private readonly settings: () => GateSettings;
  private readonly now: () => number;
  private readonly contextSize: number;
  private readonly channels = new Map<string, ChannelActivity>();
  private matcher: { key: string; match: (text: string) => string | undefined } | undefined;

  constructor(opts: AddressedGateOptions = {}) {
    this.classify = opts.classify ?? createAddressedClassifier();
    this.settings = opts.settings ?? gateSettingsFromConfig;
    this.now = opts.now ?? Date.now;
    this.contextSize = opts.contextSize ?? DEFAULT_CONTEXT_SIZE;
  }

  /** The bot posted in a channel: remember when, and who it was answering. */
  noteBotMessage(message: Message): void {
    if (!this.settings().channelIds.includes(message.channel.id)) return;
    const activity = this.activity(message.channel.id);
    activity.botSpokeAt = message.createdTimestamp;
    const pending = activity.pending && this.now() - activity.pending.at <= PENDING_PARTNER_TTL_MS;
    activity.partnerId = message.mentions?.repliedUser?.id ?? (pending ? activity.pending?.userId : undefined);
  }

  /** A turn was routed to the agent (explicit mention/reply, or the gate): its author is who the bot answers next. */
  noteRouted(message: Message): void {
    if (!this.settings().channelIds.includes(message.channel.id)) return;
    this.activity(message.channel.id).pending = { userId: message.author.id, at: this.now() };
  }

  /** Decides whether a message that neither mentions nor replies to the bot should still get an answer. */
  async evaluate(message: Message): Promise<GateVerdict> {
    const settings = this.settings();
    if (!settings.enabled) return { respond: false, reason: 'disabled' };
    const channelId = message.channel.id;
    if (!settings.channelIds.includes(channelId)) return { respond: false, reason: 'not_watched' };
    if (message.author.bot || message.webhookId || message.system) return { respond: false, reason: 'not_human' };

    const nameHit = this.nameMatcher(settings.names, message)(message.content ?? '');
    const activity = this.channels.get(channelId);
    const trackedSeconds =
      activity?.botSpokeAt !== undefined ? (message.createdTimestamp - activity.botSpokeAt) / 1000 : undefined;
    const trackedPartner = activity?.partnerId === message.author.id;
    const followup = isFollowup(trackedSeconds, trackedPartner, settings.followupSeconds);
    const trigger: GateTrigger | undefined = nameHit ? (followup ? 'name+followup' : 'name') : followup ? 'followup' : undefined;
    if (!trigger) return { respond: false, reason: 'no_trigger' };

    const botId = message.client.user.id;
    const botName = botDisplayName(message);
    const text = renderMessageText(message, botId, botName);
    const logTail = `trigger=${trigger} channel=${channelId} msg=${message.id} author=${authorName(message)} text=${JSON.stringify(truncate(text, LOG_EXCERPT_CHARS))}`;
    if (!text) return { respond: false, reason: 'no_text', trigger };

    if (this.unsolicitedCount(channelId) >= settings.maxPer10Min) {
      logger.info(`gate: skip (rate limit: ${settings.maxPer10Min} unsolicited replies per 10 min) ${logTail}`);
      return { respond: false, reason: 'rate_limited', trigger };
    }

    const input = await this.buildInput(message, settings, text, botId, botName, trackedSeconds, trackedPartner);
    let probability: number | undefined;
    try {
      probability = await this.classify(input);
    } catch (error) {
      logger.warn('gate: classifier threw:', error);
    }
    if (probability === undefined) {
      logger.warn(`gate: skip (no decision from the model) ${logTail}`);
      return { respond: false, reason: 'no_answer', trigger };
    }

    const verdict = `p=${probability.toFixed(2)} threshold=${settings.threshold}`;
    if (probability < settings.threshold) {
      logger.info(`gate: skip ${verdict} ${logTail}`);
      return { respond: false, reason: 'below_threshold', trigger, probability };
    }
    // Checked again after the (slow) decision call: concurrent candidates must not overshoot the limit.
    if (this.unsolicitedCount(channelId) >= settings.maxPer10Min) {
      logger.info(`gate: skip ${verdict} (rate limit reached meanwhile) ${logTail}`);
      return { respond: false, reason: 'rate_limited', trigger, probability };
    }

    logger.info(`gate: REPLY ${verdict} ${logTail}`);
    this.activity(channelId).unsolicitedAt.push(this.now());
    this.noteRouted(message);
    return { respond: true, trigger, probability };
  }

  private activity(channelId: string): ChannelActivity {
    let activity = this.channels.get(channelId);
    if (!activity) {
      activity = { unsolicitedAt: [] };
      this.channels.set(channelId, activity);
    }
    return activity;
  }

  private unsolicitedCount(channelId: string): number {
    const activity = this.channels.get(channelId);
    if (!activity) return 0;
    const cutoff = this.now() - RATE_WINDOW_MS;
    activity.unsolicitedAt = activity.unsolicitedAt.filter((at) => at > cutoff);
    return activity.unsolicitedAt.length;
  }

  /** The configured names plus the bot's own current names, compiled once per distinct list. */
  private nameMatcher(names: string[], message: Message): (text: string) => string | undefined {
    const all = [...names, ...ownNames(message)];
    const key = all.join('\u0000');
    if (this.matcher?.key !== key) this.matcher = { key, match: createNameMatcher(all) };
    return this.matcher.match;
  }

  private async buildInput(
    message: Message,
    settings: GateSettings,
    text: string,
    botId: string,
    botName: string,
    trackedSeconds: number | undefined,
    trackedPartner: boolean,
  ): Promise<AddressedInput> {
    const history = await this.fetchHistory(message);
    const context = history
      .map((m) => toChatLine(m, botId, botName))
      .filter((line): line is ChatLine => line !== undefined);

    let secondsSinceBotSpoke = trackedSeconds;
    let authorIsBotsPartner = trackedPartner;
    if (secondsSinceBotSpoke === undefined) {
      // Nothing tracked (e.g. right after a restart): read the same facts off the fetched history.
      const lastOwn = history.findLast((m) => m.author.id === botId && !m.webhookId);
      if (lastOwn) {
        secondsSinceBotSpoke = (message.createdTimestamp - lastOwn.createdTimestamp) / 1000;
        authorIsBotsPartner = lastOwn.mentions?.repliedUser?.id === message.author.id;
      }
    }

    return {
      botName,
      nicknames: settings.names,
      message: { author: authorName(message), text, replyTo: replyTargetName(message, botId, botName) },
      context,
      secondsSinceBotSpoke,
      authorIsBotsPartner,
    };
  }

  private async fetchHistory(message: Message): Promise<Message[]> {
    try {
      const fetched = await message.channel.messages.fetch({ limit: this.contextSize, before: message.id });
      return [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    } catch (error) {
      logger.warn(`gate: could not fetch recent messages in ${message.channel.id}, deciding without context:`, error);
      return [];
    }
  }
}

function botDisplayName(message: Message): string {
  return message.guild?.members.me?.displayName || message.client.user.displayName || 'Frigidaire';
}

/** The bot's own names count as names even when GATE_NAMES leaves them out. */
function ownNames(message: Message): string[] {
  const user = message.client.user;
  return [user.username, user.displayName, message.guild?.members.me?.displayName].filter(
    (name): name is string => typeof name === 'string' && name.length > 0,
  );
}

function authorName(message: Message): string {
  return (
    attributeMessage(message)?.authorName ||
    message.member?.displayName ||
    message.author.displayName ||
    message.author.username
  );
}

function resolveUserName(message: Message, id: string, botId: string, botName: string): string | undefined {
  if (id === botId) return botName;
  const fromMentions =
    message.mentions?.members?.get(id)?.displayName ||
    message.mentions?.users?.get(id)?.displayName ||
    message.mentions?.users?.get(id)?.username;
  if (fromMentions) return fromMentions;
  try {
    return getMemoryStore().getIdentityById(id)?.display_name;
  } catch {
    return undefined;
  }
}

/** Who a Discord reply is aimed at, by name; undefined when the message is not a reply (or it's unknown). */
function replyTargetName(message: Message, botId: string, botName: string): string | undefined {
  if (!message.reference?.messageId) return undefined;
  const target = message.mentions?.repliedUser;
  if (!target) return undefined;
  return resolveUserName(message, target.id, botId, botName) || target.displayName || target.username || undefined;
}

/** A message as a decision model reads it: text with readable markup, plus notes for non-text content. */
export function renderMessageText(message: Message, botId: string, botName: string): string {
  const parts: string[] = [];
  const content = readableMarkup(message.content ?? '', (id) => resolveUserName(message, id, botId, botName));
  if (content) parts.push(content);
  for (const attachment of message.attachments?.values() ?? []) {
    const type = attachment.contentType ?? '';
    if (type.startsWith('image/')) parts.push('[image]');
    else if (type.startsWith('video/')) parts.push('[video]');
    else if (type.startsWith('audio/')) parts.push('[voice message]');
    else parts.push(`[file: ${attachment.name}]`);
  }
  for (const sticker of message.stickers?.values() ?? []) parts.push(`[sticker: ${sticker.name}]`);
  if (!content) {
    for (const embed of message.embeds ?? []) {
      if (embed.title) parts.push(`[link preview: ${embed.title}]`);
    }
  }
  return parts.join(' ').trim();
}

function toChatLine(message: Message, botId: string, botName: string): ChatLine | undefined {
  const text = renderMessageText(message, botId, botName);
  if (!text) return undefined;
  const replyTo = replyTargetName(message, botId, botName);
  const withReply = replyTo ? { replyTo } : {};
  if (message.author.id === botId && !message.webhookId) return { author: botName, kind: 'self', text, ...withReply };
  const attribution = attributeMessage(message);
  if (attribution) return { author: attribution.authorName, text, ...withReply };
  return {
    author: message.author.displayName || message.author.username,
    kind: 'other_bot',
    text,
    ...withReply,
  };
}
