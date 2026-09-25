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
    // What Discord sends for a reply with the ping on: the replied-to author (the bot) is resolved AND
    // listed among the mentions, although nobody typed <@bot>.
    const fake = createFakeMessage({
      content: 'lmao he really said that',
      botUserId: BOT_ID,
      referencedMessageId: 'transcript-1',
      repliedUserId: BOT_ID,
      mentionedUserIds: [BOT_ID],
    });

    await aiChatEvent.execute(fake.message);

    expect(agent.handleMention).not.toHaveBeenCalled();
    expect(addressedGate.evaluate).toHaveBeenCalledWith(fake.message);
    expect(fake.recorders.messagesFetch.calls).toHaveLength(0);
  });

  it('recognizes an unrecorded transcript by its header when Discord resolved the reply (ping on)', async () => {
    const transcript = createFakeBotMessage({
      botUserId: BOT_ID,
      messageId: 'old-transcript-2',
      content: `${TRANSCRIPT_HEADER}\n> on joue ce soir?`,
    });
    const fake = createFakeMessage({
      content: 'ouais',
      botUserId: BOT_ID,
      referencedMessageId: 'old-transcript-2',
      repliedUserId: BOT_ID,
      mentionedUserIds: [BOT_ID],
      // discord.js caches the replied-to message that Discord ships with the reply.
      cachedMessages: [transcript.message],
    });

    await aiChatEvent.execute(fake.message);

    expect(agent.handleMention).not.toHaveBeenCalled();
    expect(addressedGate.evaluate).toHaveBeenCalledWith(fake.message);
    expect(fake.recorders.messagesFetch.calls).toHaveLength(0);
  });

  it('a reply (with ping) to one of its normal replies still reaches the agent, without a fetch', async () => {
    const own = createFakeBotMessage({ botUserId: BOT_ID, messageId: 'own-1', content: 'kraken into ie' });
    for (const cachedMessages of [[own.message], undefined]) {
      vi.mocked(agent.handleMention).mockClear();
      const fake = createFakeMessage({
        content: 'nah',
        botUserId: BOT_ID,
        referencedMessageId: 'own-1',
        repliedUserId: BOT_ID,
        mentionedUserIds: [BOT_ID],
        cachedMessages,
      });

      await aiChatEvent.execute(fake.message);

      expect(agent.handleMention).toHaveBeenCalledWith(fake.message);
      expect(fake.recorders.messagesFetch.calls).toHaveLength(0);
    }
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

  it('an explicit mention in a reply to a transcript still reaches the agent', async () => {
    rememberTranscriptReply('transcript-2', 'voice-2');
    const fake = createFakeMessage({
      content: `<@${BOT_ID}> what did he mean`,
      botUserId: BOT_ID,
      referencedMessageId: 'transcript-2',
      repliedUserId: BOT_ID,
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
