import type { Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../ai/agentInstance';
import { createFakeBotMessage, createFakeMessage } from '../test-support/fakeDiscord';
import * as aiChatModule from './aiChat';

// The handler is `module.exports = { name, execute }`. Under Vitest/Vite that surfaces
// as the namespace's `default` member; tsc sees only a namespace, so we bridge via unknown.
const aiChatEvent = (aiChatModule as unknown as {
  default: { name: string; execute: (message: Message) => Promise<void> };
}).default;

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
