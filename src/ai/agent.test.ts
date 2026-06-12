import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeMessage } from '../test-support/fakeDiscord';
import { FakeEmbeddingProvider } from '../test-support/fakeEmbeddings';
import { FakeProvider, errorStep, textResponse, toolCallResponse } from '../test-support/fakeProvider';
import { AgentOrchestrator } from './agent';
import { ConversationPersistence } from './conversationPersistence';
import type { ConversationState } from './conversationStore';
import { loadErrorCapture } from './debugCapture';
import { MemoryStore } from './memory/memoryStore';
import { getMemoryStore, setMemoryStoreForTesting } from './tools';
import type { ConversationEntry, ToolDefinition } from './types';

const echoTool: ToolDefinition = {
  name: 'echo_tool',
  description: 'Echo tool for tests',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  handler: async () => 'echo result',
};

const throwingTool: ToolDefinition = {
  name: 'echo_tool',
  description: 'Echo tool that throws',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    throw new Error('tool blew up');
  },
};

function makeOrchestrator(
  provider: FakeProvider,
  opts: { tools?: ToolDefinition[]; timeoutMs?: number; maxToolRounds?: number; maxToolInvocations?: number } = {},
): AgentOrchestrator {
  return new AgentOrchestrator({
    resolveProvider: () => provider,
    tools: opts.tools ?? [echoTool],
    timeoutMs: opts.timeoutMs ?? 60_000,
    maxToolRounds: opts.maxToolRounds,
    maxToolInvocations: opts.maxToolInvocations,
  });
}

function toolResultEntries(messages: ConversationEntry[]): Array<Extract<ConversationEntry, { kind: 'tool_result' }>> {
  return messages.filter((e): e is Extract<ConversationEntry, { kind: 'tool_result' }> => e.kind === 'tool_result');
}

beforeEach(() => {
  setMemoryStoreForTesting(new MemoryStore(':memory:'));
});

afterEach(() => {
  setMemoryStoreForTesting(undefined);
  vi.unstubAllEnvs();
});

describe('AgentOrchestrator.handleMention', () => {
  it('handles a text-only response', async () => {
    const provider = new FakeProvider([textResponse('Hi')]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'hello' });

    await orchestrator.handleMention(fake.message);

    expect(provider.calls).toHaveLength(1);
    expect(fake.recorders.reply.calls).toContainEqual(['Hi']);
    expect(fake.recorders.sendTyping.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('injects the emoji section with restraint guidance, not use-encouragement', async () => {
    // Seed a usable emoji so buildDeveloperPrompt includes the emoji section.
    getMemoryStore().upsertEmoji({ id: '111222333', name: 'trolle', animated: false });
    getMemoryStore().setEmojiCaption('111222333', 'a trollface');

    const provider = new FakeProvider([textResponse('Hi')]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'hello' });

    await orchestrator.handleMention(fake.message);

    const developerEntry = provider.calls[0].messages.find(
      (e): e is Extract<ConversationEntry, { kind: 'message' }> => e.kind === 'message' && e.role === 'developer',
    );
    expect(developerEntry).toBeDefined();
    const promptText = developerEntry!.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');

    // The emoji list itself is present (the model still needs to know what each emoji means)...
    expect(promptText).toContain('<:trolle:111222333>');
    expect(promptText).toContain('a trollface');

    // ...framed around restraint, not capability.
    expect(promptText).toContain('SERVER EMOJIS (use sparingly)');
    expect(promptText).toContain('NO emoji at all');
    expect(promptText).toContain('Never use more than one per message');

    // The old use-encouraging framing must be gone.
    expect(promptText).not.toContain('EMOJIS YOU CAN USE');
    expect(promptText).not.toContain('prefer emojis near the top');
  });

  it('annotates injected memory lines with their relative age and warns about stale current-state claims', async () => {
    // Default fake author display name is 'Test User', the key buildDeveloperPrompt fetches by.
    await getMemoryStore().save({ category: 'fact', subject: 'Test User', content: 'works as a plumber' });

    const provider = new FakeProvider([textResponse('Hi')]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'hello' });

    await orchestrator.handleMention(fake.message);

    // The just-saved speaker memory renders (with a 'today' age annotation) in the per-turn dynamic
    // context entry now, not the static prompt.
    expect(dynamicContextText(provider, 0)).toContain('- works as a plumber (today)');
    // The guidance sentence teaching the model to distrust stale current-state claims stays static.
    expect(developerPromptText(provider)).toContain('how long ago it was last confirmed');
  });

  it('tells the model to forget the stale memory when a fact is corrected', async () => {
    const provider = new FakeProvider([textResponse('Hi')]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'hello' });

    await orchestrator.handleMention(fake.message);

    const developerEntry = provider.calls[0].messages.find(
      (e): e is Extract<ConversationEntry, { kind: 'message' }> => e.kind === 'message' && e.role === 'developer',
    );
    expect(developerEntry).toBeDefined();
    const promptText = developerEntry!.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');

    // The correction guidance now names forget_memory and the distinctive 'has to go' phrasing.
    expect(promptText).toContain('forget_memory');
    expect(promptText).toContain('has to go');
  });

  it('executes a single tool round then replies', async () => {
    const provider = new FakeProvider([
      toolCallResponse([{ id: 't1', name: 'echo_tool', arguments: {} }]),
      textResponse('Done'),
    ]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'do the thing' });

    await orchestrator.handleMention(fake.message);

    expect(provider.calls).toHaveLength(2);
    const results = toolResultEntries(provider.calls[1].messages);
    expect(results).toContainEqual({ kind: 'tool_result', id: 't1', name: 'echo_tool', content: 'echo result' });
    expect(fake.recorders.reply.calls).toContainEqual(['Done']);
  });

  it('executes two tool rounds then replies with the final text', async () => {
    const provider = new FakeProvider([
      toolCallResponse([{ id: 't1', name: 'echo_tool', arguments: {} }]),
      toolCallResponse([{ id: 't2', name: 'echo_tool', arguments: {} }]),
      textResponse('All done'),
    ]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'two rounds' });

    await orchestrator.handleMention(fake.message);

    expect(provider.calls).toHaveLength(3);
    expect(fake.recorders.reply.calls).toContainEqual(['All done']);
  });

  it('forces a text-only response when maxToolRounds is reached', async () => {
    const provider = new FakeProvider([
      toolCallResponse([{ id: 't1', name: 'echo_tool', arguments: {} }]),
      toolCallResponse([{ id: 't2', name: 'echo_tool', arguments: {} }]),
      toolCallResponse([{ id: 't3', name: 'echo_tool', arguments: {} }]),
      textResponse('forced'),
    ]);
    const orchestrator = makeOrchestrator(provider, { maxToolRounds: 2 });
    const fake = createFakeMessage({ content: 'spam tools' });

    await orchestrator.handleMention(fake.message);

    expect(provider.calls).toHaveLength(4);
    expect(provider.calls[3].toolChoice).toBe('none');
    expect(fake.recorders.reply.calls).toContainEqual(['forced']);
  });

  it('forces a text-only response when maxToolInvocations is exceeded', async () => {
    const provider = new FakeProvider([
      toolCallResponse([
        { id: 't1', name: 'echo_tool', arguments: {} },
        { id: 't2', name: 'echo_tool', arguments: {} },
      ]),
      toolCallResponse([{ id: 't3', name: 'echo_tool', arguments: {} }]),
      textResponse('forced'),
    ]);
    const orchestrator = makeOrchestrator(provider, { maxToolInvocations: 2 });
    const fake = createFakeMessage({ content: 'too many tools' });

    await orchestrator.handleMention(fake.message);

    // First response: 2 invocations (== limit, not exceeded). Round response: 1 more -> 3 > 2, forces text.
    const forcedCall = provider.calls[provider.calls.length - 1];
    expect(forcedCall.toolChoice).toBe('none');
    expect(fake.recorders.reply.calls).toContainEqual(['forced']);
  });

  it('returns a "not supported" tool result and logs a capability gap for an unknown tool', async () => {
    // The provider advertises unknown_tool as host-handled, but the orchestrator has no handler for
    // it — that's the gap the orchestrator must report.
    const provider = new FakeProvider(
      [toolCallResponse([{ id: 't1', name: 'unknown_tool', arguments: {} }]), textResponse('ok')],
      {
        supportedTools: [
          { name: 'unknown_tool', type: 'function', description: 'no handler', hostHandled: true },
        ],
      },
    );
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'use a missing tool' });

    await orchestrator.handleMention(fake.message);

    const results = toolResultEntries(provider.calls[1].messages);
    expect(results.some((r) => r.content.includes('not supported'))).toBe(true);
    expect(getMemoryStore().getByCategory('capability_gap').length).toBeGreaterThan(0);
  });

  it('returns a "failed to run" tool result and logs a tool error when the handler throws', async () => {
    const provider = new FakeProvider([
      toolCallResponse([{ id: 't1', name: 'echo_tool', arguments: {} }]),
      textResponse('ok'),
    ]);
    const orchestrator = makeOrchestrator(provider, { tools: [throwingTool] });
    const fake = createFakeMessage({ content: 'break the tool' });

    await orchestrator.handleMention(fake.message);

    const results = toolResultEntries(provider.calls[1].messages);
    expect(results.some((r) => r.content.includes('failed to run'))).toBe(true);
    expect(getMemoryStore().getByCategory('tool_error').length).toBeGreaterThan(0);
  });

  it('writes an error capture when the provider throws', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-'));
    vi.stubEnv('DEBUG_CAPTURE_DIR', dir);

    const provider = new FakeProvider([errorStep('boom')]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'trigger error' });

    await orchestrator.handleMention(fake.message);

    expect(fake.recorders.reply.calls.some(([arg]) => typeof arg === 'string' && /encountered an error/.test(arg))).toBe(
      true,
    );

    const captureFiles = fs.readdirSync(dir).filter((f) => f.startsWith('error-') && f.endsWith('.json'));
    expect(captureFiles).toHaveLength(1);

    const capture = loadErrorCapture(path.join(dir, captureFiles[0]));
    expect(capture.error.message).toBe('boom');
    expect(capture.conversationEntries.length).toBeGreaterThan(0);
  });

  it('handles an empty final text and logs a parse failure', async () => {
    const provider = new FakeProvider([{ text: undefined, toolCalls: [], outputEntries: [] }]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'say nothing' });

    await orchestrator.handleMention(fake.message);

    expect(
      fake.recorders.reply.calls.some(([arg]) => typeof arg === 'string' && /further to add/.test(arg)),
    ).toBe(true);
    expect(getMemoryStore().getByCategory('parse_failure').length).toBeGreaterThan(0);
  });

  it('splits a long response into multiple replies', async () => {
    const provider = new FakeProvider([textResponse('a'.repeat(2500))]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'long please' });

    await orchestrator.handleMention(fake.message);

    expect(fake.recorders.reply.calls).toHaveLength(2);
  });

  it('falls back to channel.send when reply throws a 50035 error', async () => {
    const provider = new FakeProvider([textResponse('via send')]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({
      content: 'reply will fail',
      replyImpl: async () => {
        throw Object.assign(new Error('no reply'), { code: 50035 });
      },
    });

    await orchestrator.handleMention(fake.message);

    expect(fake.recorders.send.calls).toContainEqual(['via send']);
  });

  it('reuses conversation state across mentions in the same channel', async () => {
    const provider = new FakeProvider([textResponse('first'), textResponse('second')]);
    const orchestrator = makeOrchestrator(provider);
    const fake1 = createFakeMessage({ content: 'first message', channelId: 'shared', messageId: 'm1' });
    const fake2 = createFakeMessage({ content: 'second message', channelId: 'shared', messageId: 'm2' });

    await orchestrator.handleMention(fake1.message);
    await orchestrator.handleMention(fake2.message);

    // History is only fetched on the first mention.
    expect(fake1.recorders.messagesFetch.calls).toHaveLength(1);
    expect(fake2.recorders.messagesFetch.calls).toHaveLength(0);
    // The second call carries more history than the first.
    expect(provider.calls[1].messages.length).toBeGreaterThan(provider.calls[0].messages.length);
  });

  it('refetches history after the conversation expires', async () => {
    const provider = new FakeProvider([textResponse('first'), textResponse('second')]);
    const orchestrator = makeOrchestrator(provider, { timeoutMs: 1 });
    const fake1 = createFakeMessage({ content: 'first message', channelId: 'expiring', messageId: 'm1' });
    const fake2 = createFakeMessage({ content: 'second message', channelId: 'expiring', messageId: 'm2' });

    await orchestrator.handleMention(fake1.message);
    await new Promise((r) => setTimeout(r, 10));
    await orchestrator.handleMention(fake2.message);

    expect(fake1.recorders.messagesFetch.calls).toHaveLength(1);
    expect(fake2.recorders.messagesFetch.calls).toHaveLength(1);
  });
});

function developerPromptText(provider: FakeProvider): string {
  const developerEntry = provider.calls[0].messages.find(
    (e): e is Extract<ConversationEntry, { kind: 'message' }> => e.kind === 'message' && e.role === 'developer',
  );
  return developerEntry?.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n') ?? '';
}

// The per-turn dynamic context entry for the chat call at `callIndex`. It is the developer message
// spliced in right before that turn's new user entry (the last message at chat() time); messages[0]
// is the static prompt and is never the dynamic entry. Returns '' when the turn injected nothing.
function dynamicContextText(provider: FakeProvider, callIndex = 0): string {
  const messages = provider.calls[callIndex].messages;
  const candidate = messages.at(-2);
  if (candidate && candidate !== messages[0] && candidate.kind === 'message' && candidate.role === 'developer') {
    return candidate.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  }
  return '';
}

function lastUserText(provider: FakeProvider): string {
  const userEntries = provider.calls[0].messages.filter(
    (e): e is Extract<ConversationEntry, { kind: 'message' }> => e.kind === 'message' && e.role === 'user',
  );
  const last = userEntries.at(-1);
  return last?.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n') ?? '';
}

function lastQuery(embeddings: FakeEmbeddingProvider): string {
  const queryCalls = embeddings.calls.filter((c) => c.kind === 'query');
  expect(queryCalls.length).toBeGreaterThan(0);
  return queryCalls.at(-1)!.texts[0];
}

// Discord ids are numeric snowflakes; the mention regex matches `\d+` only (as the original strip
// regex did), so tests must use numeric ids.
const BOT_ID = '900000000000000001';
const WHEEZER_ID = '137738554762592257';
const SPEAKER_ID = '111111111111111111';
const STRANGER_ID = '222222222222222222';

describe('AgentOrchestrator @-mention resolution', () => {
  it('resolves a mentioned user into the semantic-search query instead of stripping them', async () => {
    const embeddings = new FakeEmbeddingProvider();
    setMemoryStoreForTesting(new MemoryStore(':memory:', { embeddings }));

    const provider = new FakeProvider([textResponse('Hi')]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({
      content: `whats up with <@${WHEEZER_ID}>`,
      botUserId: BOT_ID,
      mentionedUsers: [{ id: WHEEZER_ID, displayName: 'Wheezer' }],
    });

    await orchestrator.handleMention(fake.message);

    const query = lastQuery(embeddings);
    expect(query).toContain('@Wheezer');
    expect(query).not.toContain('<@');
  });

  it('falls back to the identities table when a mention has no live display data', async () => {
    const embeddings = new FakeEmbeddingProvider();
    const store = new MemoryStore(':memory:', { embeddings });
    store.upsertIdentity(WHEEZER_ID, 'Wheezer');
    setMemoryStoreForTesting(store);

    const provider = new FakeProvider([textResponse('Hi')]);
    const orchestrator = makeOrchestrator(provider);
    // mentionedUserIds populates mentions.users with a bare entry (no display name), forcing the
    // identities-table fallback.
    const fake = createFakeMessage({
      content: `hows <@${WHEEZER_ID}> doing`,
      botUserId: BOT_ID,
      mentionedUserIds: [WHEEZER_ID],
    });

    await orchestrator.handleMention(fake.message);

    expect(lastQuery(embeddings)).toContain('@Wheezer');
  });

  it("strips the bot's own trigger mention from the query", async () => {
    const embeddings = new FakeEmbeddingProvider();
    setMemoryStoreForTesting(new MemoryStore(':memory:', { embeddings }));

    const provider = new FakeProvider([textResponse('Hi')]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({
      content: `<@${BOT_ID}> what is the weather`,
      botUserId: BOT_ID,
      mentionedUserIds: [BOT_ID],
    });

    await orchestrator.handleMention(fake.message);

    const query = lastQuery(embeddings);
    expect(query).toBe('what is the weather');
    expect(query).not.toContain(BOT_ID);
    expect(query).not.toContain('@');
  });

  it("strips an unknown mention (no live data, no identity) — today's behavior", async () => {
    const embeddings = new FakeEmbeddingProvider();
    setMemoryStoreForTesting(new MemoryStore(':memory:', { embeddings }));

    const provider = new FakeProvider([textResponse('Hi')]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({
      content: `what about <@${STRANGER_ID}> then`,
      botUserId: BOT_ID,
      mentionedUserIds: [STRANGER_ID],
    });

    await orchestrator.handleMention(fake.message);

    const query = lastQuery(embeddings);
    expect(query).toBe('what about then');
    expect(query).not.toContain('<@');
    expect(query).not.toContain(STRANGER_ID);
  });

  it('injects subject memories for a mentioned user', async () => {
    // High relevance gate so the contextual-search leg returns nothing and the dedicated mentioned
    // pull is the only thing that can surface Wheezer's memory.
    const store = new MemoryStore(':memory:', { embeddings: new FakeEmbeddingProvider(), relevanceThreshold: 0.99 });
    await store.save({ category: 'fact', subject: 'Wheezer', content: 'plays valorant every night' });
    setMemoryStoreForTesting(store);

    const provider = new FakeProvider([textResponse('Hi')]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({
      content: `whats up with <@${WHEEZER_ID}>`,
      botUserId: BOT_ID,
      mentionedUsers: [{ id: WHEEZER_ID, displayName: 'Wheezer' }],
    });

    await orchestrator.handleMention(fake.message);

    const dynamicText = dynamicContextText(provider, 0);
    expect(dynamicText).toContain('What you know about others mentioned in this message:');
    expect(dynamicText).toContain('- Wheezer: plays valorant every night');
  });

  it('excludes the bot and the speaker from the mentioned-subjects pull', async () => {
    const store = new MemoryStore(':memory:');
    await store.save({ category: 'fact', subject: 'Frigidaire', content: 'is a fridge' });
    await store.save({ category: 'fact', subject: 'Speaker', content: 'speaker fact' });
    setMemoryStoreForTesting(store);

    const provider = new FakeProvider([textResponse('Hi')]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({
      content: `hey <@${BOT_ID}> and <@${SPEAKER_ID}>`,
      botUserId: BOT_ID,
      authorId: SPEAKER_ID,
      authorDisplayName: 'Speaker',
      mentionedUsers: [
        { id: BOT_ID, displayName: 'Frigidaire' },
        { id: SPEAKER_ID, displayName: 'Speaker' },
      ],
    });

    await orchestrator.handleMention(fake.message);

    expect(dynamicContextText(provider, 0)).not.toContain('others mentioned in this message');
  });

  it('resolves mention tokens in the model-visible user message text', async () => {
    setMemoryStoreForTesting(new MemoryStore(':memory:'));

    const provider = new FakeProvider([textResponse('Hi')]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({
      content: `yo <@${WHEEZER_ID}> you up`,
      botUserId: BOT_ID,
      mentionedUsers: [{ id: WHEEZER_ID, displayName: 'Wheezer' }],
    });

    await orchestrator.handleMention(fake.message);

    const userText = lastUserText(provider);
    expect(userText).toContain('@Wheezer');
    expect(userText).not.toContain('<@');
  });
});

describe('AgentOrchestrator per-turn memory refresh', () => {
  it('refreshes contextual retrieval on a second mention', async () => {
    // relevanceThreshold 0.99 keeps the contextual leg empty so only the dedicated mentioned pull can
    // surface Wheezer — proving retrieval re-ran on turn 2 rather than reusing a frozen prompt.
    const store = new MemoryStore(':memory:', { embeddings: new FakeEmbeddingProvider(), relevanceThreshold: 0.99 });
    await store.save({ category: 'fact', subject: 'Wheezer', content: 'plays valorant every night' });
    setMemoryStoreForTesting(store);

    const provider = new FakeProvider([textResponse('first'), textResponse('second')]);
    const orchestrator = makeOrchestrator(provider);
    const turn1 = createFakeMessage({ content: 'hows it going', channelId: 'c', messageId: 'm1', botUserId: BOT_ID });
    const turn2 = createFakeMessage({
      content: `whats up with <@${WHEEZER_ID}>`,
      channelId: 'c',
      messageId: 'm2',
      botUserId: BOT_ID,
      mentionedUsers: [{ id: WHEEZER_ID, displayName: 'Wheezer' }],
    });

    await orchestrator.handleMention(turn1.message);
    await orchestrator.handleMention(turn2.message);

    expect(dynamicContextText(provider, 0)).not.toContain('plays valorant every night');
    expect(dynamicContextText(provider, 1)).toContain('- Wheezer: plays valorant every night');
  });

  it('keeps the static prompt byte-identical across mentions', async () => {
    const store = new MemoryStore(':memory:', { embeddings: new FakeEmbeddingProvider() });
    await store.save({ category: 'fact', subject: 'Test User', content: 'works as a plumber' });
    setMemoryStoreForTesting(store);

    const provider = new FakeProvider([textResponse('first'), textResponse('second')]);
    const orchestrator = makeOrchestrator(provider);
    const turn1 = createFakeMessage({ content: 'hello', channelId: 'c', messageId: 'm1' });
    const turn2 = createFakeMessage({ content: 'hello again', channelId: 'c', messageId: 'm2' });

    await orchestrator.handleMention(turn1.message);
    await orchestrator.handleMention(turn2.message);

    // entries[0] is the static developer prompt — mutating it every turn would bust provider caching.
    expect(provider.calls[1].messages[0]).toEqual(provider.calls[0].messages[0]);
  });

  it('does not duplicate a memory across consecutive turns', async () => {
    const store = new MemoryStore(':memory:');
    await store.save({ category: 'fact', subject: 'Test User', content: 'works as a plumber' });
    setMemoryStoreForTesting(store);

    const provider = new FakeProvider([textResponse('first'), textResponse('second')]);
    const orchestrator = makeOrchestrator(provider);
    const turn1 = createFakeMessage({ content: 'hello', channelId: 'c', messageId: 'm1' });
    const turn2 = createFakeMessage({ content: 'hello again', channelId: 'c', messageId: 'm2' });

    await orchestrator.handleMention(turn1.message);
    await orchestrator.handleMention(turn2.message);

    expect(dynamicContextText(provider, 0)).toContain('- works as a plumber');
    expect(dynamicContextText(provider, 1)).not.toContain('works as a plumber');
  });

  it('does not re-run semantic search during tool rounds', async () => {
    const embeddings = new FakeEmbeddingProvider();
    setMemoryStoreForTesting(new MemoryStore(':memory:', { embeddings }));

    const provider = new FakeProvider([
      toolCallResponse([{ id: 't1', name: 'echo_tool', arguments: {} }]),
      textResponse('done'),
    ]);
    const orchestrator = makeOrchestrator(provider);
    const fake = createFakeMessage({ content: 'do the thing please' });

    await orchestrator.handleMention(fake.message);

    expect(provider.calls).toHaveLength(2);
    // The dynamic context is built once per mention (outside the tool loop), so exactly one query embed.
    expect(embeddings.calls.filter((c) => c.kind === 'query')).toHaveLength(1);
  });

  it('refreshes the speaker bucket when a different user speaks mid-conversation', async () => {
    const store = new MemoryStore(':memory:');
    await store.save({ category: 'fact', subject: 'Alice', content: 'alice mains support' });
    await store.save({ category: 'fact', subject: 'Bob', content: 'bob mains duelist' });
    setMemoryStoreForTesting(store);

    const provider = new FakeProvider([textResponse('first'), textResponse('second')]);
    const orchestrator = makeOrchestrator(provider);
    const turn1 = createFakeMessage({
      content: 'hi',
      channelId: 'c',
      messageId: 'm1',
      authorId: 'alice-id',
      authorDisplayName: 'Alice',
    });
    const turn2 = createFakeMessage({
      content: 'yo',
      channelId: 'c',
      messageId: 'm2',
      authorId: 'bob-id',
      authorDisplayName: 'Bob',
    });

    await orchestrator.handleMention(turn1.message);
    await orchestrator.handleMention(turn2.message);

    expect(dynamicContextText(provider, 0)).toContain('- alice mains support');
    // The bug this fixes: the speaker bucket used to freeze to the first speaker of the window.
    expect(dynamicContextText(provider, 1)).toContain('- bob mains duelist');
  });

  it('re-injects a memory after the conversation window expires', async () => {
    const store = new MemoryStore(':memory:');
    await store.save({ category: 'fact', subject: 'Test User', content: 'works as a plumber' });
    setMemoryStoreForTesting(store);

    const provider = new FakeProvider([textResponse('first'), textResponse('second')]);
    const orchestrator = makeOrchestrator(provider, { timeoutMs: 1 });
    const turn1 = createFakeMessage({ content: 'hello', channelId: 'c', messageId: 'm1' });
    const turn2 = createFakeMessage({ content: 'hello', channelId: 'c', messageId: 'm2' });

    await orchestrator.handleMention(turn1.message);
    await new Promise((r) => setTimeout(r, 10));
    await orchestrator.handleMention(turn2.message);

    // A fresh window resets injectedMemoryIds, so the same memory is allowed to render again.
    expect(dynamicContextText(provider, 0)).toContain('- works as a plumber');
    expect(dynamicContextText(provider, 1)).toContain('- works as a plumber');
  });
});

describe('AgentOrchestrator conversation persistence', () => {
  it('restores persisted state across a restart instead of rebuilding initial history', async () => {
    // Simulate a pre-restart conversation already cached on disk.
    const persistence = new ConversationPersistence(':memory:');
    const restoredEntries: ConversationEntry[] = [
      { kind: 'message', role: 'developer', content: [{ type: 'text', text: 'RESTORED-STATIC-PROMPT' }] },
      { kind: 'message', role: 'user', content: [{ type: 'text', text: 'earlier message' }] },
      { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'earlier reply' }] },
    ];
    const persisted: ConversationState = {
      providerId: 'fake',
      entries: restoredEntries,
      timestamp: Date.now(),
      injectedMemoryIds: [],
    };
    persistence.save('channel-1', persisted);

    // A fresh orchestrator (new process) restores from the same disk cache on construction.
    const provider = new FakeProvider([textResponse('welcome back')]);
    const orchestrator = new AgentOrchestrator({
      resolveProvider: () => provider,
      tools: [echoTool],
      timeoutMs: 60_000,
      persistence,
    });
    const fake = createFakeMessage({ content: 'still there?', channelId: 'channel-1' });

    await orchestrator.handleMention(fake.message);

    // The provider sees the RESTORED history (static prompt + prior turns), not a freshly-built one.
    expect(provider.calls[0].messages[0]).toEqual(restoredEntries[0]);
    expect(developerPromptText(provider)).toContain('RESTORED-STATIC-PROMPT');
    expect(provider.calls[0].messages).toContainEqual(restoredEntries[1]);
    // buildInitialHistory (which fetches the last ~25 channel messages) was never invoked.
    expect(fake.recorders.messagesFetch.calls).toHaveLength(0);

    persistence.close();
  });
});
