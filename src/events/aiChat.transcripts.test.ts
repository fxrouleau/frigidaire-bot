// The bot's auto-transcripts of voice messages are not the bot talking: replying to one is not replying
// to the bot, and posting one doesn't open a conversation the gate should follow up on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../ai/agentInstance';
import { TRANSCRIPT_HEADER } from '../ai/media/autoTranscribe';
import { rememberTranscriptReply } from '../ai/media/store';
import { addressedGate } from '../gate';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { createFakeBotMessage, createFakeMessage } from '../test-support/fakeDiscord';
import aiChatEvent from './aiChat';

const BOT_ID = 'bot-1';

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  vi.spyOn(agent, 'handleMention').mockResolvedValue(undefined);
  vi.spyOn(addressedGate, 'evaluate').mockResolvedValue({ respond: false, reason: 'below_threshold' });
});

afterEach(() => {
  vi.restoreAllMocks();
  setBotDbForTesting(undefined);
});

describe('aiChat and transcript replies', () => {
  it('a reply (with ping) to a transcript reply goes to the gate, not straight to the agent', async () => {
    rememberTranscriptReply('transcript-1', 'voice-1');
    const fake = createFakeMessage({
      content: 'lmao he really said that',
      botUserId: BOT_ID,
      referencedMessageId: 'transcript-1',
      repliedUserId: BOT_ID,
      // Discord's default: the reply pings, which also lists the bot in mentions.users.
      replyPinged: true,
    });

    await aiChatEvent.execute(fake.message);

    expect(agent.handleMention).not.toHaveBeenCalled();
    expect(addressedGate.evaluate).toHaveBeenCalledWith(fake.message);
    expect(fake.recorders.messagesFetch.calls).toHaveLength(0);
  });

  it('recognizes a transcript reply it has no record of by its header', async () => {
    const transcript = createFakeBotMessage({
      botUserId: BOT_ID,
      messageId: 'old-transcript',
      content: `${TRANSCRIPT_HEADER}\n> on joue ce soir?`,
    });
    const fake = createFakeMessage({
      content: 'ouais',
      botUserId: BOT_ID,
      referencedMessageId: 'old-transcript',
      fetchedMessageById: { 'old-transcript': transcript.message },
    });

    await aiChatEvent.execute(fake.message);

    expect(agent.handleMention).not.toHaveBeenCalled();
  });

  it('recognizes a transcript it has no record of from the cached replied-to message, pinged or not', async () => {
    const transcript = createFakeBotMessage({
      botUserId: BOT_ID,
      messageId: 'pruned-transcript',
      content: `${TRANSCRIPT_HEADER}\n> on joue ce soir?`,
    });
    for (const replyPinged of [true, false]) {
      const fake = createFakeMessage({
        content: 'ouais',
        botUserId: BOT_ID,
        referencedMessageId: 'pruned-transcript',
        repliedUserId: BOT_ID,
        replyPinged,
        cachedMessages: [transcript.message],
      });

      await aiChatEvent.execute(fake.message);

      expect(fake.recorders.messagesFetch.calls).toHaveLength(0);
    }
    expect(agent.handleMention).not.toHaveBeenCalled();
    expect(addressedGate.evaluate).toHaveBeenCalledTimes(2);
  });

  it('a pinging reply to an ordinary bot message still reaches the agent', async () => {
    const said = createFakeBotMessage({ botUserId: BOT_ID, messageId: 'said-1', content: 'kraken into ie' });
    const fake = createFakeMessage({
      content: 'no way',
      botUserId: BOT_ID,
      referencedMessageId: 'said-1',
      repliedUserId: BOT_ID,
      replyPinged: true,
      cachedMessages: [said.message],
    });

    await aiChatEvent.execute(fake.message);

    expect(agent.handleMention).toHaveBeenCalledWith(fake.message);
    expect(addressedGate.evaluate).not.toHaveBeenCalled();
  });

  it('a mention written in a pinging reply to a transcript still reaches the agent', async () => {
    rememberTranscriptReply('transcript-3', 'voice-3');
    const fake = createFakeMessage({
      content: `<@${BOT_ID}> what did he mean`,
      botUserId: BOT_ID,
      referencedMessageId: 'transcript-3',
      repliedUserId: BOT_ID,
      replyPinged: true,
    });

    await aiChatEvent.execute(fake.message);

    expect(agent.handleMention).toHaveBeenCalledWith(fake.message);
  });

  it('an explicit mention in a reply to a transcript still reaches the agent', async () => {
    rememberTranscriptReply('transcript-2', 'voice-2');
    const fake = createFakeMessage({
      content: 'fridge what did he mean',
      botUserId: BOT_ID,
      referencedMessageId: 'transcript-2',
      mentionedUserIds: [BOT_ID],
    });

    await aiChatEvent.execute(fake.message);

    expect(agent.handleMention).toHaveBeenCalledWith(fake.message);
  });

  it("doesn't tell the gate about its own transcript replies", async () => {
    const noteBotMessage = vi.spyOn(addressedGate, 'noteBotMessage');
    const transcript = createFakeBotMessage({
      botUserId: BOT_ID,
      content: `${TRANSCRIPT_HEADER}\n> hello`,
      repliedUserId: 'user-1',
    });

    await aiChatEvent.execute(transcript.message);

    expect(noteBotMessage).not.toHaveBeenCalled();
  });
});
