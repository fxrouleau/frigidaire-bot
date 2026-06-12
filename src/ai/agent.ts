import * as process from 'node:process';
import { type Message, StickerFormatType } from 'discord.js';
import { logger } from '../logger';
import { splitMessage } from '../utils';
import type { ConversationPersistence } from './conversationPersistence';
import { ConversationStore } from './conversationStore';
import { writeErrorCapture } from './debugCapture';
import { logFailure } from './failureLogger';
import type { EmojiRow, Identity, Memory, MemoryStore } from './memory/memoryStore';
import { getProviderForChannel } from './providerRegistry';
import { getMemoryStore, toolDefinitions } from './tools';
import type {
  AiProvider,
  ConversationEntry,
  NormalizedContentPart,
  ProviderChatResponse,
  ProviderToolCall,
  ToolDefinition,
} from './types';
import { formatRelativeAge, formatTimestampET } from './utils';

const CONVERSATION_TIMEOUT = Number(process.env.CONVERSATION_TIMEOUT_MS) || 15 * 60 * 1000; // 15 minutes
const MAX_TOOL_ROUNDS = Number(process.env.MAX_TOOL_ROUNDS) || 10;
const MAX_TOOL_INVOCATIONS = Number(process.env.MAX_TOOL_INVOCATIONS) || 50;

// `<@123>` / `<@!123>` user mentions (the legacy `!` is the old nickname form). Role (`<@&>`) and
// channel (`<#>`) mentions are deliberately not matched.
const USER_MENTION_REGEX = /<@!?(\d+)>/g;
// Bound prompt growth: at most this many distinct mentioned users get a subject-memory pull.
const MAX_MENTIONED_SUBJECTS = 3;

/**
 * Rewrites user-mention tokens in `text`: the bot's own ping is removed (it's the trigger, noise in
 * every message), other ids become `@DisplayName`, and unresolved ids are dropped — matching the
 * pre-existing strip behavior when nothing resolves. Collapses spaces a removed token leaves behind.
 */
function resolveMentionTokens(text: string, botUserId: string, resolve: (id: string) => string | undefined): string {
  return text
    .replace(USER_MENTION_REGEX, (_match, id: string) => {
      if (id === botUserId) return '';
      const name = resolve(id);
      return name ? `@${name}` : '';
    })
    .replace(/ {2,}/g, ' ')
    .trim();
}

export type AgentOrchestratorOptions = {
  resolveProvider?: (channelId: string) => AiProvider | undefined;
  tools?: ToolDefinition[];
  timeoutMs?: number;
  maxToolRounds?: number;
  maxToolInvocations?: number;
  // When provided, conversation state is mirrored to disk so it survives a restart within the timeout
  // window. Default (undefined) keeps the store pure in-memory — existing tests stay hermetic.
  persistence?: ConversationPersistence;
};

export class AgentOrchestrator {
  private readonly store: ConversationStore;
  private readonly resolveProvider: (channelId: string) => AiProvider | undefined;
  private readonly tools: ToolDefinition[];
  private readonly maxToolRounds: number;
  private readonly maxToolInvocations: number;

  constructor(opts: AgentOrchestratorOptions = {}) {
    this.store = new ConversationStore(opts.timeoutMs ?? CONVERSATION_TIMEOUT, opts.persistence);
    this.resolveProvider = opts.resolveProvider ?? getProviderForChannel;
    this.tools = opts.tools ?? toolDefinitions;
    this.maxToolRounds = opts.maxToolRounds ?? MAX_TOOL_ROUNDS;
    this.maxToolInvocations = opts.maxToolInvocations ?? MAX_TOOL_INVOCATIONS;
  }

  async handleMention(message: Message) {
    const stopTyping = this.startTypingLoop(message);
    const botName = message.client.user.displayName;
    const provider = this.resolveProvider(message.channel.id);
    if (!provider) {
      stopTyping();
      await message.reply('No AI provider is configured for this bot.');
      return;
    }

    this.store.pruneExpired();
    const channelId = message.channel.id;
    let state = this.store.get(channelId);

    if (!state) {
      const { entries: initialEntries, injectedMemoryIds } = await this.buildInitialHistory(message, provider);
      state = {
        providerId: provider.id,
        entries: initialEntries,
        injectedMemoryIds,
        timestamp: Date.now(),
      };
      this.store.set(channelId, state);
    }

    if (!state) {
      stopTyping();
      await message.reply('Failed to initialize the conversation state.');
      return;
    }

    const providerTools = provider.supportedTools;
    const userEntry = this.buildUserEntry(message);

    // Per-turn memory refresh: rebuild the dynamic context (speaker bucket + contextual search +
    // mentioned-subject pulls) once per mention, before chat() and outside the tool loop, so topic
    // shifts and new @-mentions mid-conversation get fresh retrieval. The static prompt (entries[0])
    // is never touched, preserving provider prefix-caching.
    const priorInjectedIds = state.injectedMemoryIds ?? [];
    const store = this.safeStore();
    const dynamic = store
      ? await this.buildDynamicContextEntry(message, store, priorInjectedIds)
      : { entry: undefined, injectedIds: [] };
    const injectedMemoryIds = [...priorInjectedIds, ...dynamic.injectedIds];

    const workingEntries: ConversationEntry[] = dynamic.entry
      ? [...state.entries, dynamic.entry, userEntry]
      : [...state.entries, userEntry];

    try {
      const firstResponse = await provider.chat({
        messages: workingEntries,
        tools: providerTools,
        toolChoice: 'auto',
        thoughts: state.thoughts,
      });

      workingEntries.push(...firstResponse.outputEntries);

      const hostHandledCalls = firstResponse.toolCalls.filter((call) => {
        const providerTool = providerTools.find((tool) => tool.name === call.name);
        return providerTool?.hostHandled ?? false;
      });

      if (hostHandledCalls.length > 0) {
        const toolResults = await this.executeToolCalls(hostHandledCalls, message, provider, channelId);
        workingEntries.push(...toolResults);

        let totalInvocations = hostHandledCalls.length;
        let lastThoughts = firstResponse.thoughts ?? state.thoughts;
        let finalResponse: ProviderChatResponse | undefined;

        for (let round = 0; round < this.maxToolRounds; round++) {
          const roundResponse = await provider.chat({
            messages: workingEntries,
            tools: providerTools,
            toolChoice: 'auto',
            thoughts: lastThoughts,
          });

          workingEntries.push(...roundResponse.outputEntries);
          lastThoughts = roundResponse.thoughts ?? lastThoughts;

          const roundToolCalls = roundResponse.toolCalls.filter((call) => {
            const providerTool = providerTools.find((tool) => tool.name === call.name);
            return providerTool?.hostHandled ?? false;
          });

          if (roundToolCalls.length === 0) {
            finalResponse = roundResponse;
            break;
          }

          totalInvocations += roundToolCalls.length;
          if (totalInvocations > this.maxToolInvocations) {
            logger.warn(
              `Tool invocation limit (${this.maxToolInvocations}) exceeded in channel ${channelId}, forcing text response.`,
            );
            const forcedResponse = await provider.chat({
              messages: workingEntries,
              tools: providerTools,
              toolChoice: 'none',
              thoughts: lastThoughts,
            });
            workingEntries.push(...forcedResponse.outputEntries);
            finalResponse = forcedResponse;
            lastThoughts = forcedResponse.thoughts ?? lastThoughts;
            break;
          }

          const roundResults = await this.executeToolCalls(roundToolCalls, message, provider, channelId);
          workingEntries.push(...roundResults);

          // Last allowed round — force a text-only response
          if (round === this.maxToolRounds - 1) {
            const forcedResponse = await provider.chat({
              messages: workingEntries,
              tools: providerTools,
              toolChoice: 'none',
              thoughts: lastThoughts,
            });
            workingEntries.push(...forcedResponse.outputEntries);
            finalResponse = forcedResponse;
            lastThoughts = forcedResponse.thoughts ?? lastThoughts;
          }
        }

        stopTyping();
        await this.sendReply(finalResponse?.text, message);

        this.store.set(channelId, {
          providerId: provider.id,
          entries: workingEntries,
          injectedMemoryIds,
          thoughts: finalResponse?.thoughts ?? lastThoughts,
          timestamp: Date.now(),
        });
        return;
      }

      stopTyping();
      await this.sendReply(firstResponse.text, message);

      this.store.set(channelId, {
        providerId: provider.id,
        entries: workingEntries,
        injectedMemoryIds,
        thoughts: firstResponse.thoughts ?? state.thoughts,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error('Error while processing AI response:', error);
      logFailure(
        'tool_error',
        `Error processing message in #${channelId}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      const capturePath = writeErrorCapture({
        channelId,
        model: provider.defaultModel,
        error,
        conversationEntries: workingEntries,
        thoughts: state.thoughts,
      });
      if (capturePath) {
        logger.info(`Error capture written to ${capturePath}`);
      }
      stopTyping();
      try {
        await message.reply('Sorry, I encountered an error while processing your request.');
      } catch (replyError) {
        logger.warn('Failed to reply with error message, falling back to channel.send():', replyError);
        try {
          if ('send' in message.channel) {
            await message.channel.send('Sorry, I encountered an error while processing your request.');
          }
        } catch (sendError) {
          logger.error('Failed to send error message to channel:', sendError);
        }
      }
    } finally {
      stopTyping();
    }
  }

  private async executeToolCalls(
    calls: ProviderToolCall[],
    message: Message,
    provider: AiProvider,
    channelId: string,
  ): Promise<ConversationEntry[]> {
    const results: ConversationEntry[] = [];
    for (const call of calls) {
      const toolDefinition = this.tools.find((tool) => tool.name === call.name);
      if (!toolDefinition) {
        logger.warn(`Tool ${call.name} was requested but no handler is registered.`);
        logFailure('capability_gap', `Tool "${call.name}" requested but no handler is registered`);
        results.push({
          kind: 'tool_result',
          id: call.id,
          name: call.name,
          content: `The tool "${call.name}" is not supported by this bot.`,
        });
        continue;
      }

      try {
        logger.info(`Executing host tool "${call.name}" for provider "${provider.id}" in channel ${channelId}.`);
        const toolOutput = await toolDefinition.handler(
          {
            message,
            providerId: provider.id,
            provider,
            channelId,
            switchProvider: () => ({ error: 'Provider switching is not supported.' }),
          },
          call.arguments,
        );
        results.push({ kind: 'tool_result', id: call.id, name: call.name, content: toolOutput });
      } catch (error) {
        logger.error(`Error while executing tool ${call.name}:`, error);
        logFailure(
          'tool_error',
          `Tool "${call.name}" threw an error: ${error instanceof Error ? error.message : 'unknown'}`,
        );
        results.push({
          kind: 'tool_result',
          id: call.id,
          name: call.name,
          content: `The tool "${call.name}" failed to run.`,
        });
      }
    }
    return results;
  }

  private async buildInitialHistory(
    message: Message,
    _provider: AiProvider,
  ): Promise<{ entries: ConversationEntry[]; injectedMemoryIds: number[] }> {
    const botName = message.client.user.displayName;
    const { text: basePrompt, injectedIds } = await this.buildStaticDeveloperPrompt(botName);
    const entries: ConversationEntry[] = [
      {
        kind: 'message',
        role: 'developer',
        content: [{ type: 'text', text: basePrompt }],
      },
    ];

    const recentMessages = await message.channel.messages.fetch({ limit: 25, before: message.id });
    const historicalContext: ConversationEntry[] = [...recentMessages.values()]
      .reverse()
      .filter((msg) => !msg.author.bot || msg.author.id === message.client.user.id || msg.webhookId !== null)
      .map((msg) => {
        const isAssistant = msg.author.id === message.client.user.id;

        if (isAssistant) {
          return {
            kind: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: msg.content }],
          } satisfies ConversationEntry;
        }

        return this.buildHistoricalUserEntry(msg);
      });

    entries.push(...historicalContext);
    return { entries, injectedMemoryIds: injectedIds };
  }

  private buildUserEntry(message: Message): ConversationEntry {
    return {
      kind: 'message',
      role: 'user',
      content: this.buildUserContentParts(message),
    };
  }

  private buildHistoricalUserEntry(message: Message): ConversationEntry {
    return {
      kind: 'message',
      role: 'user',
      content: this.buildUserContentParts(message),
    };
  }

  /**
   * The static leading developer prompt: persona + SERVER PEOPLE + SERVER EMOJIS + the vibe/personality
   * bucket + background-knowledge/age guidance + current ET time. Built ONCE per conversation window and
   * never mutated — providers prefix-cache on a byte-identical leading message, so per-turn churn here
   * would bust the whole conversation's cache. Per-turn retrieval lives in buildDynamicContextEntry().
   * Returns the memory ids it baked in (the vibe/personality bucket) to seed cross-turn dedup.
   */
  private async buildStaticDeveloperPrompt(botName: string): Promise<{ text: string; injectedIds: number[] }> {
    const now = new Date();
    const tz = 'America/New_York';
    const currentTimeEt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    }).format(now);

    // Fetch identities, emojis, and the vibe/personality bucket for context injection.
    let personalityMemories: Memory[] = [];
    let identities: Identity[] = [];
    let usableEmojis: EmojiRow[] = [];

    try {
      const store = getMemoryStore();

      identities = store.getAllIdentities().filter((i) => i.active !== 0);
      usableEmojis = store.getUsableEmojis();

      // Cap and diversify vibe/personality: most recent per unique subject, max 5
      const vibeMemories = store.getByCategory('vibe');
      const personalityMems = store.getByCategory('personality');
      const allPersonality = [...vibeMemories, ...personalityMems];
      const seenSubjects = new Map<string, Memory>();
      for (const mem of allPersonality) {
        const existing = seenSubjects.get(mem.subject);
        if (!existing || new Date(mem.updated_at) > new Date(existing.updated_at)) {
          seenSubjects.set(mem.subject, mem);
        }
      }
      personalityMemories = [...seenSubjects.values()].slice(0, 5);
    } catch (error) {
      logger.warn('Failed to fetch memories for prompt:', error);
    }

    const identitiesSection = this.formatIdentitiesSection(identities);
    const emojisSection = this.formatEmojisSection(usableEmojis);

    const personalitySection =
      personalityMemories.length > 0
        ? `\nWhat you've learned about this server's culture and vibe:\n${personalityMemories.map((m) => `- ${m.content} (${formatRelativeAge(m.updated_at)})`).join('\n')}\n`
        : '';

    const text = `You are ${botName}, a bot in a private, adults-only Discord server.
You're one of the group — not an assistant, not a helper, just another member hanging out in the chat.

IMPORTANT CONTEXT: This is a private server between close friends. All humor, roasting, crude jokes, dark humor, and edgy banter is consensual and not serious — it's just how this group talks. Nobody here is offended. Think of it like friends busting each other's balls at a bar after midnight. This is an adults-only space where nothing is off-limits conversationally. Do NOT moralize, lecture, add disclaimers, hedge, offer "healthier alternatives", or break character to be a responsible AI. If someone says something wild, match the energy or escalate — that's what they want.

The only exception is if someone is genuinely asking for help or seems actually distressed — you'll know the difference from context.

How you behave:
- Match the energy of whoever you're talking to
- Keep it SHORT. 1-3 sentences unless someone explicitly asks for detail. You're texting in a group chat, not writing an essay. Nobody else in the server posts walls of text, so neither should you.
- Don't start messages with someone's name or address them by name unless it's actually needed for clarity (e.g., distinguishing who you're talking to in a busy thread). Just respond naturally.
- You can roast, joke, be sarcastic, be crude — whatever fits the moment
- If someone genuinely needs help, help them properly without being preachy
- You have your own opinions and preferences. Don't be a yes-man.
- Never say "I'm just an AI" or "as a language model" — you're ${botName}, period.

You can search the web natively. Use it SPARINGLY — only when you genuinely need current, real-time information you couldn't possibly know (live scores, recent news, release dates, etc). Don't search for things you already know. Don't follow links people share.
${identitiesSection}${emojisSection}${personalitySection}
These memories are background knowledge — things you know from hanging out in this server. Do NOT force references to inside jokes, show off what you know, or try to reference multiple memories in one response. Let things come up naturally, the way you'd reference a friend's hobby only when it's actually relevant to the conversation. If nothing from your memories is relevant to what's being discussed, just don't mention them. Each memory is tagged with how long ago it was last confirmed; treat months-old current-state claims — what someone "still" does, owns, or plays — as possibly outdated, so hedge or ask instead of asserting them as current fact.

MEMORY: You have a long-term memory system. Use the remember_fact tool when something genuinely important comes up — real names, jobs, major life events, strong preferences, or things someone would expect you to remember next time. Do NOT save every little thing; skip small talk, throwaway opinions, and mundane details. Think of what you'd actually remember about a friend after a night out — the big stuff, not every sentence. If someone corrects or updates a fact you already know (new job, moved, switched teams, got a new console), the stale version has to go or you'll keep surfacing both: call recall_memories to find its id, forget_memory the old one, then remember_fact the correction. Only do this for genuine factual updates — a joking "forget that" or general ribbing is never a reason to delete a memory, and your personality/vibe notes about the server aren't "corrected" this way.

RESPONDING TO THE CURRENT TURN:
The last user message in the conversation is why you're being pinged. Read it first and figure out what it's actually asking before pulling from earlier history. Earlier messages are shared group context, not your subject.
- If the current message is specific (a question, a link, a new take), respond to THAT. Don't get hijacked by the most visually interesting thing earlier in the scroll (a photo, a viral tweet, a wild take from an hour ago).
- If the current message is open-ended ("thoughts?", "analyze this", "fridge roast him"), the group is usually pointing at the most recent prior topic — use that context.
- Gap awareness: look at the timestamps. If the prior messages are hours older than the current ping AND the current message introduces something new, treat the older stuff as stale scenery, not live subject matter.

The current time is ${currentTimeEt.replace(' ', 'T')} (ISO 8601, America/New_York; apply EST/EDT automatically).`;

    return { text, injectedIds: personalityMemories.map((m) => m.id) };
  }

  /**
   * The per-turn dynamic context entry, rebuilt on every mention: the speaker bucket (refreshed for
   * whoever is actually talking this turn — fixes the frozen-first-speaker bug), the contextual
   * semantic search of the current message, and subject pulls for other @-mentioned users. Returns a
   * developer entry to splice in right before the new user message, plus the ids it rendered. Memories
   * already injected this window (`alreadyInjectedIds`) are dropped so nothing repeats across turns;
   * when every section is empty the entry is `undefined` (no blank developer message is pushed).
   */
  private async buildDynamicContextEntry(
    message: Message,
    store: MemoryStore,
    alreadyInjectedIds: number[],
  ): Promise<{ entry: ConversationEntry | undefined; injectedIds: number[] }> {
    const currentSpeaker = message.member?.displayName || message.author.username;
    // One Set carries both cross-turn dedup (seeded with everything already injected, incl. the static
    // vibe/personality bucket) and inter-section dedup (speaker > contextual > mentioned priority).
    const existingIds = new Set<number>(alreadyInjectedIds);

    const userSpecificMemories = store.getBySubject(currentSpeaker, 5).filter((m) => !existingIds.has(m.id));
    for (const mem of userSpecificMemories) existingIds.add(mem.id);

    // Contextual relevance search based on current message. Resolve @-mentions to display names
    // (rather than stripping them) so the person being asked about survives into the search query.
    let contextualMemories: Memory[] = [];
    const searchText = resolveMentionTokens(message.content, message.client.user.id, (id) =>
      this.resolveMentionDisplayName(id, message, store),
    );
    if (searchText.length >= 3) {
      try {
        const results = await store.search(searchText, 10);
        contextualMemories = results.filter((m) => !existingIds.has(m.id));
      } catch (error) {
        logger.warn('Failed to fetch contextual memories:', error);
      }
    }
    for (const mem of contextualMemories) existingIds.add(mem.id);

    // Pull subject-keyed memories for other people @-mentioned in the message, so "what's up with
    // @Wheezer" surfaces what we know about Wheezer even when nothing keyword-matches.
    const mentionedMemories = this.collectMentionedSubjectMemories(message, store, existingIds);

    const userSection =
      userSpecificMemories.length > 0
        ? `\nWhat you know about the person talking to you right now (${currentSpeaker}):\n${userSpecificMemories.map((m) => `- ${m.content} (${formatRelativeAge(m.updated_at)})`).join('\n')}\n`
        : '';

    const mentionedSection =
      mentionedMemories.length > 0
        ? `\nWhat you know about others mentioned in this message:\n${mentionedMemories.map((m) => `- ${m.subject}: ${m.content} (${formatRelativeAge(m.updated_at)})`).join('\n')}\n`
        : '';

    const contextualSection =
      contextualMemories.length > 0
        ? `\nRelevant to this conversation:\n${contextualMemories.map((m) => `- [${m.category}] ${m.subject}: ${m.content} (${formatRelativeAge(m.updated_at)})`).join('\n')}\n`
        : '';

    const text = `${userSection}${mentionedSection}${contextualSection}`.trim();
    if (text.length === 0) {
      return { entry: undefined, injectedIds: [] };
    }

    const injectedIds = [
      ...userSpecificMemories.map((m) => m.id),
      ...contextualMemories.map((m) => m.id),
      ...mentionedMemories.map((m) => m.id),
    ];
    return {
      entry: { kind: 'message', role: 'developer', content: [{ type: 'text', text }] },
      injectedIds,
    };
  }

  /**
   * Resolves a mentioned user's id to a display name: live guild member data first (most accurate
   * current nickname), then the resolved User, then the identities table by discord_user_id — whose
   * `display_name` is the exact key memories are stored under. Returns undefined when nothing knows
   * the id, so callers fall back to stripping (today's behavior).
   */
  private resolveMentionDisplayName(id: string, message: Message, store: MemoryStore | undefined): string | undefined {
    const memberName = message.mentions.members?.get(id)?.displayName;
    if (memberName) return memberName;
    const userName = message.mentions.users.get(id)?.displayName;
    if (userName) return userName;
    return store?.getIdentityById(id)?.display_name;
  }

  /**
   * Collects subject-keyed memories for the (non-bot, non-speaker) users @-mentioned in the message.
   * Caps the number of distinct users and dedups against memories already injected via `alreadyInjected`.
   */
  private collectMentionedSubjectMemories(
    message: Message,
    store: MemoryStore,
    alreadyInjected: Set<number>,
  ): Memory[] {
    const botUserId = message.client.user.id;
    const speakerId = message.author.id;
    const seenIds = new Set<string>();
    const collected: Memory[] = [];
    let resolvedUsers = 0;

    for (const match of message.content.matchAll(USER_MENTION_REGEX)) {
      const id = match[1];
      if (id === botUserId || id === speakerId || seenIds.has(id)) continue;
      seenIds.add(id);

      const displayName = this.resolveMentionDisplayName(id, message, store);
      if (!displayName) continue;

      for (const mem of store.getBySubject(displayName, 3)) {
        if (alreadyInjected.has(mem.id)) continue;
        alreadyInjected.add(mem.id);
        collected.push(mem);
      }

      resolvedUsers++;
      if (resolvedUsers >= MAX_MENTIONED_SUBJECTS) break;
    }

    return collected;
  }

  private safeStore(): MemoryStore | undefined {
    try {
      return getMemoryStore();
    } catch {
      return undefined;
    }
  }

  private formatIdentitiesSection(identities: Identity[]): string {
    if (identities.length === 0) return '';

    const lines = identities.map((i) => {
      const displayPart =
        i.canonical_name === i.display_name ? i.canonical_name : `${i.canonical_name} (now: ${i.display_name})`;
      const irlPart = i.irl_name ? ` — IRL: ${i.irl_name}` : '';
      const aliasPart = i.aliases.length > 0 ? `. Also called: ${i.aliases.join(', ')}` : '';
      return `- ${displayPart} (id:${i.discord_user_id})${irlPart}${aliasPart}`;
    });

    return `\n=== SERVER PEOPLE ===\n${lines.join('\n')}\n`;
  }

  private formatEmojisSection(emojis: EmojiRow[]): string {
    if (emojis.length === 0) return '';

    const lines = emojis.map((e) => {
      const syntax = e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`;
      const captionPart = e.caption ? ` — ${e.caption}` : '';
      return `- ${syntax}${captionPart}`;
    });

    // Deliberately framed around restraint: a prominent capability list with "prefer these" guidance
    // reads to the model as an instruction to use emojis in every message (Felix's complaint).
    return `
=== SERVER EMOJIS (use sparingly) ===
These are the server's custom emojis (most-used first) so you know what each one means. Usage rules:
- MOST of your messages should have NO emoji at all. Plain text is the default — that's how everyone else here talks.
- Drop one in only when it genuinely adds something: a reaction, a punchline, matching the moment. If you're unsure, skip it.
- Never decorate ordinary sentences with emojis. Never use more than one per message unless you're quoting someone.
- Only these custom emojis render properly; when you do use one, paste the exact syntax shown.
${lines.join('\n')}
`;
  }

  private buildUserContentParts(msg: Message): NormalizedContentPart[] {
    const parts: NormalizedContentPart[] = [];
    const authorLabel = msg.member?.displayName || msg.author.username;
    // Resolve @-mentions to readable names (same logic as the search query) so the model reads
    // "@Wheezer" rather than a raw numeric id. Only touches the store when a mention is present.
    const rawContent = msg.content ?? '';
    const mentionStore = rawContent.includes('<@') ? this.safeStore() : undefined;
    const trimmed = resolveMentionTokens(rawContent, msg.client.user.id, (id) =>
      this.resolveMentionDisplayName(id, msg, mentionStore),
    );
    const ts = formatTimestampET(msg.createdAt);
    // Webhook reposts use the webhook's author ID (not the original user's), so omit the ID in that case.
    const idSuffix = !msg.webhookId && !msg.author.bot ? ` (id:${msg.author.id})` : '';
    const header = `[${ts}] ${authorLabel}${idSuffix}`;
    const baseText = trimmed ? `${header}: ${trimmed}` : `${header}:`;
    parts.push({ type: 'text', text: baseText });

    // Extract custom emoji images so the model can "see" them
    const customEmojiRegex = /<a?:(\w+):(\d+)>/g;
    const emojiMatches = (msg.content ?? '').matchAll(customEmojiRegex);
    for (const match of emojiMatches) {
      const [, , emojiId] = match;
      const isAnimated = match[0].startsWith('<a:');
      const ext = isAnimated ? 'gif' : 'png';
      const emojiUrl = `https://cdn.discordapp.com/emojis/${emojiId}.${ext}?size=96&quality=lossless`;
      parts.push({ type: 'image', url: emojiUrl });
    }

    if (msg.attachments.size > 0) {
      for (const attachment of msg.attachments.values()) {
        if (attachment.contentType?.startsWith('image/') && attachment.url) {
          parts.push({ type: 'image', url: attachment.url });
        }
      }
    }

    for (const embed of msg.embeds) {
      const imageUrl = embed.image?.url || embed.thumbnail?.url;
      if (imageUrl) {
        parts.push({ type: 'image', url: imageUrl });
      }
      const fields: string[] = [];
      if (embed.author?.name) fields.push(`author=${embed.author.name}`);
      if (embed.title) fields.push(`title=${embed.title}`);
      if (embed.description) fields.push(`description=${embed.description}`);
      if (embed.url) fields.push(`url=${embed.url}`);
      if (fields.length > 0) {
        parts.push({ type: 'text', text: `[embed: ${fields.join(' | ')}]` });
      }
    }

    // Include sticker images so the model can see them
    if (msg.stickers.size > 0) {
      for (const sticker of msg.stickers.values()) {
        if (sticker.format === StickerFormatType.Lottie) {
          parts.push({ type: 'text', text: `[sticker: ${sticker.name}]` });
        } else {
          const stickerUrl = `https://media.discordapp.net/stickers/${sticker.id}.png?size=320`;
          parts.push({ type: 'image', url: stickerUrl });
        }
      }
    }

    return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
  }

  private async sendReply(content: string | undefined, message: Message) {
    if (!content) {
      const authorName = message.member?.displayName || message.author.username;
      logFailure('parse_failure', `Empty LLM response for message from ${authorName}`);
      await this.safeSend(message, "I've processed the information, but I don't have anything further to add.");
      return;
    }

    const chunks = splitMessage(content);
    for (const chunk of chunks) {
      await this.safeSend(message, chunk);
    }
  }

  private async safeSend(message: Message, content: string): Promise<void> {
    try {
      await message.reply(content);
    } catch (error: unknown) {
      const isReplyError =
        error instanceof Error && 'code' in error && (error as Record<string, unknown>).code === 50035;
      if (isReplyError && 'send' in message.channel) {
        logger.warn('Cannot reply to this message (system/webhook message), falling back to channel.send()');
        await message.channel.send(content);
      } else if (!isReplyError) {
        throw error;
      }
    }
  }

  private startTypingLoop(message: Message): () => void {
    const channel = message.channel;
    if (!channel.isTextBased() || !('sendTyping' in channel)) {
      return () => {};
    }

    let active = true;
    let timer: NodeJS.Timeout | undefined;

    const tick = async () => {
      if (!active) return;
      try {
        await channel.sendTyping();
      } catch (error) {
        logger.warn('Failed to send typing indicator:', error);
        active = false;
        return;
      }
      if (active) {
        timer = setTimeout(tick, 8000);
      }
    };

    tick();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }
}
