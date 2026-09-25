import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../ai/agentInstance';
import { DECISIONS_ENDPOINT } from '../ai/decisions';
import { addressedGate } from '../gate';
import { createFakeBotMessage, createFakeMessage } from '../test-support/fakeDiscord';
import aiChatEvent from './aiChat';

const BOT_ID = 'bot-1';

describe('aiChat event', () => {
  beforeEach(() => {
    vi.spyOn(agent, 'handleMention').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the MessageCreate event name', () => {
    expect(aiChatEvent.name).toBe('messageCreate');
  });

  it('ignores messages authored by a bot', async () => {
    const fake = createFakeMessage({
      authorIsBot: true,
      botUserId: BOT_ID,
      mentionedUserIds: [BOT_ID],
    });

    await aiChatEvent.execute(fake.message);

    expect(agent.handleMention).not.toHaveBeenCalled();
  });

  it('routes to the agent when the bot is explicitly mentioned', async () => {
    const fake = createFakeMessage({
      content: 'hey bot',
      botUserId: BOT_ID,
      mentionedUserIds: [BOT_ID],
    });

    await aiChatEvent.execute(fake.message);

    expect(agent.handleMention).toHaveBeenCalledTimes(1);
    expect(agent.handleMention).toHaveBeenCalledWith(fake.message);
  });

  it('routes to the agent when replying to a bot message', async () => {
    const repliedTo = createFakeBotMessage({ botUserId: BOT_ID, messageId: 'ref-1' });
    const fake = createFakeMessage({
      content: 'replying',
      botUserId: BOT_ID,
      referencedMessageId: 'ref-1',
      fetchedMessageById: { 'ref-1': repliedTo.message },
    });

    await aiChatEvent.execute(fake.message);

    expect(agent.handleMention).toHaveBeenCalledTimes(1);
    expect(agent.handleMention).toHaveBeenCalledWith(fake.message);
  });

  it('uses the resolved replied-to user instead of fetching the message when Discord provides it', async () => {
    const fake = createFakeMessage({
      content: 'replying with ping',
      botUserId: BOT_ID,
      referencedMessageId: 'ref-1',
      repliedUserId: BOT_ID,
    });

    await aiChatEvent.execute(fake.message);

    expect(agent.handleMention).toHaveBeenCalledTimes(1);
    expect(fake.recorders.messagesFetch.calls).toHaveLength(0);
  });

  it('does NOT route (and does not fetch) when the resolved replied-to user is a human', async () => {
    const fake = createFakeMessage({
      content: 'replying to a human with ping',
      botUserId: BOT_ID,
      referencedMessageId: 'ref-1',
      repliedUserId: 'human-2',
    });

    await aiChatEvent.execute(fake.message);

    expect(agent.handleMention).not.toHaveBeenCalled();
    expect(fake.recorders.messagesFetch.calls).toHaveLength(0);
  });

  it('does NOT route when replying to a human message', async () => {
    const repliedTo = createFakeMessage({
      authorId: 'human-2',
      botUserId: BOT_ID,
      messageId: 'ref-1',
    });
    const fake = createFakeMessage({
      content: 'replying to a human',
      botUserId: BOT_ID,
      referencedMessageId: 'ref-1',
      fetchedMessageById: { 'ref-1': repliedTo.message },
    });

    await aiChatEvent.execute(fake.message);

    expect(agent.handleMention).not.toHaveBeenCalled();
  });

  it('does NOT route for a plain message with no mention and no reply', async () => {
    const fake = createFakeMessage({ content: 'just chatting', botUserId: BOT_ID });

    await aiChatEvent.execute(fake.message);

    expect(agent.handleMention).not.toHaveBeenCalled();
  });

  it('does NOT route and swallows the error when the reply lookup fails', async () => {
    // referencedMessageId is set but no entry is registered, so the fetch impl rejects.
    const fake = createFakeMessage({
      content: 'reply to a deleted message',
      botUserId: BOT_ID,
      referencedMessageId: 'missing-ref',
      fetchedMessageById: {},
    });

    // isReplyToBot must catch the rejection — execute should resolve cleanly.
    await expect(aiChatEvent.execute(fake.message)).resolves.toBeUndefined();
    expect(agent.handleMention).not.toHaveBeenCalled();
  });
});

describe('aiChat event: replying without a mention (the gate)', () => {
  beforeEach(() => {
    vi.spyOn(agent, 'handleMention').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("feeds the bot's own posts to the gate and stops there", async () => {
    const noteBotMessage = vi.spyOn(addressedGate, 'noteBotMessage');
    const evaluate = vi.spyOn(addressedGate, 'evaluate');
    const own = createFakeBotMessage({ botUserId: BOT_ID, content: 'kraken into ie', repliedUserId: 'user-1' });

    await aiChatEvent.execute(own.message);

    expect(noteBotMessage).toHaveBeenCalledWith(own.message);
    expect(evaluate).not.toHaveBeenCalled();
    expect(agent.handleMention).not.toHaveBeenCalled();
  });

  it("does not treat the bot's webhook relays as its own posts", async () => {
    const noteBotMessage = vi.spyOn(addressedGate, 'noteBotMessage');
    const relay = createFakeMessage({ botUserId: BOT_ID, authorId: BOT_ID, webhookId: 'wh-1', content: 'fridge lol' });

    await aiChatEvent.execute(relay.message);

    expect(noteBotMessage).not.toHaveBeenCalled();
    expect(agent.handleMention).not.toHaveBeenCalled();
  });

  it('tells the gate about explicit mentions (routed, then done) without asking it to decide', async () => {
    const noteRouted = vi.spyOn(addressedGate, 'noteRouted');
    const noteTurnDone = vi.spyOn(addressedGate, 'noteTurnDone');
    const evaluate = vi.spyOn(addressedGate, 'evaluate');
    const fake = createFakeMessage({ content: 'hey', botUserId: BOT_ID, mentionedUserIds: [BOT_ID] });

    await aiChatEvent.execute(fake.message);

    expect(noteRouted).toHaveBeenCalledWith(fake.message);
    expect(noteTurnDone).toHaveBeenCalledWith(fake.message);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('routes a message the gate says is addressed to the bot, and marks the turn done even if it fails', async () => {
    vi.spyOn(addressedGate, 'evaluate').mockResolvedValue({ respond: true, trigger: 'name', probability: 0.9, cold: true });
    const noteTurnDone = vi.spyOn(addressedGate, 'noteTurnDone');
    vi.mocked(agent.handleMention).mockRejectedValueOnce(new Error('boom'));
    const fake = createFakeMessage({ content: 'fridge who wins worlds', botUserId: BOT_ID });

    await expect(aiChatEvent.execute(fake.message)).rejects.toThrow('boom');

    expect(agent.handleMention).toHaveBeenCalledWith(fake.message);
    expect(noteTurnDone).toHaveBeenCalledWith(fake.message);
  });

  it('stays quiet when the gate says no', async () => {
    vi.spyOn(addressedGate, 'evaluate').mockResolvedValue({ respond: false, reason: 'below_threshold' });
    await aiChatEvent.execute(createFakeMessage({ content: 'the beer is in the fridge', botUserId: BOT_ID }).message);
    expect(agent.handleMention).not.toHaveBeenCalled();
  });

  it('end to end: GATE_CHANNELS + a decision-model yes routes the message to the agent', async () => {
    vi.stubEnv('GATE_CHANNELS', 'gate-e2e-channel');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    const bodies: Array<Record<string, unknown>> = [];
    const fetchStub = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ answers: { answer: { type: 'noul', noul: 0.93 } } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStub);
    const fake = createFakeMessage({
      content: 'yo fridge settle this, is a hotdog a sandwich',
      botUserId: BOT_ID,
      channelId: 'gate-e2e-channel',
      messageId: 'gate-e2e-1',
    });

    await aiChatEvent.execute(fake.message);

    expect(fetchStub.mock.calls[0][0]).toBe(DECISIONS_ENDPOINT);
    expect(bodies[0]).toMatchObject({ model: 'typesafe/jev-1.13', provider: { zdr: true } });
    expect(agent.handleMention).toHaveBeenCalledWith(fake.message);
  });

  it('never calls the decision model outside the gate channels', async () => {
    vi.stubEnv('GATE_CHANNELS', 'gate-e2e-channel');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);

    await aiChatEvent.execute(
      createFakeMessage({ content: 'fridge hello', botUserId: BOT_ID, channelId: 'somewhere-else' }).message,
    );

    expect(fetchStub).not.toHaveBeenCalled();
    expect(agent.handleMention).not.toHaveBeenCalled();
  });
});
