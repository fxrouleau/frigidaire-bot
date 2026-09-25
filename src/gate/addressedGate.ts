// Replying without an @-mention: decides whether a message nobody pinged the bot in is still meant for
// it ("fridge who wins worlds", or "why tho" right after the bot answered that person).
//
// Order matters for cost: every check up to the caps is free and runs on every message in the gate's
// channels; only a candidate costs a REST fetch of a few messages of context plus one decision-model
// call (~$0.00001). The decision fails closed: no answer, or a probability under GATE_THRESHOLD, means
// no reply.
//
// Conversations come in bursts, so the gate thinks in *exchanges*, not single replies. A channel has an
// active exchange while the bot answered someone there within GATE_FOLLOWUP_SECONDS (sliding: every
// answer extends it, and a turn still being answered keeps it open). Everyone the bot has exchanged with
// since the exchange began is a partner, and a partner's message is a candidate without naming the bot.
// During an exchange only the high runaway guard (GATE_MAX_PER_10MIN) applies; a *cold* interjection (a
// name-drop with no active exchange) has its own small cap (GATE_MAX_COLD_PER_10MIN). Explicit
// @-mentions and replies never reach the gate, so they are never capped.
//
// Exchanges come from routed turns only (aiChat reports every turn it hands to the agent, and when it
// ends), never from the bot's own posts: a ramble nudge, a voice-message transcript or a reminder
// replies to someone without being a conversation with them. Partners compare through isSamePerson(),
// so a member's side account continues their main account's exchange. This state is in memory: after
// a restart, follow-ups without a name work again once the bot has answered someone.
import type { Message } from 'discord.js';
import { getMemoryStore } from '../ai/memory';
import { config } from '../config';
import { canonicalUserId, isSamePerson } from '../linkedAccounts';
import { logger } from '../logger';
import { attributeMessage } from '../relay';
import { type AddressedClassifier, type AddressedInput, type ChatLine, createAddressedClassifier } from './addressed';
import { createNameMatcher, readableMarkup, truncate } from './text';

const CAP_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_CONTEXT_SIZE = 6;
// A routed turn keeps its channel's exchange open while it runs, but a turn that never reports back
// (aiChat always does; this is the backstop) stops counting after this long.
const PENDING_TURN_TTL_MS = 5 * 60 * 1000;
const LOG_EXCERPT_CHARS = 80;

export type GateSettings = {
  enabled: boolean;
  channelIds: string[];
  names: string[];
  /** Length of an active exchange after the bot's last answer; 0 disables follow-ups. */
  followupSeconds: number;
  /** Runaway guard: unprompted replies of every kind per channel per rolling 10 minutes. */
  maxPer10Min: number;
  /** Cold interjections (a name-drop with no active exchange) per channel per rolling 10 minutes. */
  maxColdPer10Min: number;
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
    maxColdPer10Min: gate.maxColdPer10Min,
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
  /** The runaway guard (GATE_MAX_PER_10MIN). */
  | 'rate_limited'
  /** The cold-interjection cap (GATE_MAX_COLD_PER_10MIN). */
  | 'cold_limited'
  | 'no_answer'
  | 'below_threshold';

/** `cold`: a name-drop with no active exchange in the channel (the kind with the small cap). */
export type GateVerdict =
  | { respond: true; trigger: GateTrigger; probability: number; cold: boolean }
  | { respond: false; reason: GateSkipReason; trigger?: GateTrigger; probability?: number; cold?: boolean };

type ChannelState = {
  /** createdTimestamp of the bot's last post here (any post in words): only the decision's timing uses it. */
  botSpokeAt?: number;
  /** When a routed turn last finished here, i.e. the bot answered someone. Drives the active exchange. */
  lastAnsweredAt?: number;
  /** Everyone the bot has exchanged with since the current exchange began: canonical user id → last time. */
  partners: Map<string, number>;
  /** Turns handed to the agent and not finished yet, by message id: their authors are partners already. */
  pending: Map<string, { userId: string; at: number }>;
  /** Unprompted replies the gate routed here, for the caps. */
  routed: Array<{ at: number; cold: boolean }>;
};

type CapReason = 'rate_limited' | 'cold_limited';

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
  private readonly channels = new Map<string, ChannelState>();
  private matcher: { key: string; match: (text: string) => string | undefined } | undefined;

  constructor(opts: AddressedGateOptions = {}) {
    this.classify = opts.classify ?? createAddressedClassifier();
    this.settings = opts.settings ?? gateSettingsFromConfig;
    this.now = opts.now ?? Date.now;
    this.contextSize = opts.contextSize ?? DEFAULT_CONTEXT_SIZE;
  }

  /**
   * The bot posted in a channel: remember when, for the decision's "the bot spoke N seconds ago". Who it
   * is talking to comes from routed turns instead (see the header), so a nudge never starts an exchange.
   */
  noteBotMessage(message: Message): void {
    if (!this.settings().channelIds.includes(message.channel.id)) return;
    this.state(message.channel.id).botSpokeAt = message.createdTimestamp;
  }

  /** A turn was handed to the agent (explicit mention/reply, or the gate): its author joins the exchange. */
  noteRouted(message: Message): void {
    const settings = this.settings();
    if (!settings.channelIds.includes(message.channel.id)) return;
    const now = this.now();
    // Read through current(): a turn arriving after the last exchange lapsed starts a fresh one.
    const state = this.current(message.channel.id, settings, now);
    state.pending.set(message.id, { userId: message.author.id, at: now });
  }

  /** The routed turn for `message` finished: the bot answered its author, which extends the exchange. */
  noteTurnDone(message: Message): void {
    const state = this.channels.get(message.channel.id);
    const turn = state?.pending.get(message.id);
    if (!state || !turn) return;
    state.pending.delete(message.id);
    const now = this.now();
    state.lastAnsweredAt = now;
    state.partners.set(canonicalUserId(turn.userId), now);
  }

  /** Decides whether a message that neither mentions nor replies to the bot should still get an answer. */
  async evaluate(message: Message): Promise<GateVerdict> {
    const settings = this.settings();
    if (!settings.enabled) return { respond: false, reason: 'disabled' };
    const channelId = message.channel.id;
    if (!settings.channelIds.includes(channelId)) return { respond: false, reason: 'not_watched' };
    if (message.author.bot || message.webhookId || message.system) return { respond: false, reason: 'not_human' };

    const now = this.now();
    const state = this.current(channelId, settings, now);
    const active = this.isActive(state, settings, now);
    const partner = active && this.isPartner(state, message.author.id);
    const nameHit = this.nameMatcher(settings.names, message)(message.content ?? '') !== undefined;
    const trigger = triggerFor(nameHit, partner);
    if (!trigger) return { respond: false, reason: 'no_trigger' };
    const cold = !active;

    const botId = message.client.user.id;
    const botName = botDisplayName(message);
    const text = renderMessageText(message, botId, botName);
    const logTail = `trigger=${trigger} mode=${cold ? 'cold' : 'exchange'} channel=${channelId} msg=${message.id} author=${authorName(message)} text=${JSON.stringify(truncate(text, LOG_EXCERPT_CHARS))}`;
    if (!text) return { respond: false, reason: 'no_text', trigger, cold };

    const capped = this.capReached(state, settings, cold, now);
    if (capped) {
      logger.info(`gate: skip (${describeCap(capped, settings)}) ${logTail}`);
      return { respond: false, reason: capped, trigger, cold };
    }

    const trackedSeconds =
      state.botSpokeAt !== undefined ? (message.createdTimestamp - state.botSpokeAt) / 1000 : undefined;
    const input = await this.buildInput(message, settings, text, botId, botName, trackedSeconds, partner);
    let probability: number | undefined;
    try {
      probability = await this.classify(input);
    } catch (error) {
      logger.warn('gate: classifier threw:', error);
    }
    if (probability === undefined) {
      logger.warn(`gate: skip (no decision from the model) ${logTail}`);
      return { respond: false, reason: 'no_answer', trigger, cold };
    }

    const verdict = `p=${probability.toFixed(2)} threshold=${settings.threshold}`;
    if (probability < settings.threshold) {
      logger.info(`gate: skip ${verdict} ${logTail}`);
      return { respond: false, reason: 'below_threshold', trigger, probability, cold };
    }
    // Checked again after the (slow) decision call: concurrent candidates must not overshoot a cap.
    const cappedMeanwhile = this.capReached(state, settings, cold, this.now());
    if (cappedMeanwhile) {
      logger.info(`gate: skip ${verdict} (${describeCap(cappedMeanwhile, settings)}, reached meanwhile) ${logTail}`);
      return { respond: false, reason: cappedMeanwhile, trigger, probability, cold };
    }

    logger.info(`gate: REPLY ${verdict} ${logTail}`);
    state.routed.push({ at: this.now(), cold });
    this.noteRouted(message);
    return { respond: true, trigger, probability, cold };
  }

  private state(channelId: string): ChannelState {
    let state = this.channels.get(channelId);
    if (!state) {
      state = { partners: new Map(), pending: new Map(), routed: [] };
      this.channels.set(channelId, state);
    }
    return state;
  }

  /** The channel's state with stale turns dropped, and its partners forgotten once the exchange lapsed. */
  private current(channelId: string, settings: GateSettings, now: number): ChannelState {
    const state = this.state(channelId);
    for (const [messageId, turn] of state.pending) {
      if (now - turn.at > PENDING_TURN_TTL_MS) state.pending.delete(messageId);
    }
    if (!this.isActive(state, settings, now)) state.partners.clear();
    return state;
  }

  private isActive(state: ChannelState, settings: GateSettings, now: number): boolean {
    if (settings.followupSeconds <= 0) return false;
    if (state.pending.size > 0) return true;
    return state.lastAnsweredAt !== undefined && now - state.lastAnsweredAt <= settings.followupSeconds * 1000;
  }

  private isPartner(state: ChannelState, userId: string): boolean {
    for (const partnerId of state.partners.keys()) {
      if (isSamePerson(partnerId, userId)) return true;
    }
    for (const turn of state.pending.values()) {
      if (isSamePerson(turn.userId, userId)) return true;
    }
    return false;
  }

  /** Which cap, if any, stops another unprompted reply in this channel right now. */
  private capReached(state: ChannelState, settings: GateSettings, cold: boolean, now: number): CapReason | undefined {
    state.routed = state.routed.filter((entry) => now - entry.at < CAP_WINDOW_MS);
    if (state.routed.length >= settings.maxPer10Min) return 'rate_limited';
    if (cold && state.routed.filter((entry) => entry.cold).length >= settings.maxColdPer10Min) return 'cold_limited';
    return undefined;
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
    partner: boolean,
  ): Promise<AddressedInput> {
    const history = await this.fetchHistory(message);
    const context = history
      .map((m) => toChatLine(m, botId, botName))
      .filter((line): line is ChatLine => line !== undefined);

    let secondsSinceBotSpoke = trackedSeconds;
    let authorIsBotsPartner = partner;
    if (secondsSinceBotSpoke === undefined) {
      // Nothing tracked (e.g. right after a restart): read the same facts off the fetched history.
      const lastOwn = history.findLast((m) => m.author.id === botId && !m.webhookId);
      if (lastOwn) {
        secondsSinceBotSpoke = (message.createdTimestamp - lastOwn.createdTimestamp) / 1000;
        authorIsBotsPartner ||= isSamePerson(lastOwn.mentions?.repliedUser?.id, message.author.id);
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

function triggerFor(nameHit: boolean, followup: boolean): GateTrigger | undefined {
  if (nameHit && followup) return 'name+followup';
  if (nameHit) return 'name';
  return followup ? 'followup' : undefined;
}

function describeCap(cap: CapReason, settings: GateSettings): string {
  return cap === 'rate_limited'
    ? `runaway guard: ${settings.maxPer10Min} unprompted replies per 10 min`
    : `cold cap: ${settings.maxColdPer10Min} cold interjections per 10 min`;
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
