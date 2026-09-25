// Deleting a voice message deletes the bot's transcript replies to it and forgets the cached text.
import { Collection, type Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getStoredTranscript, isStoredTranscriptReply, rememberTranscriptReply, storeTranscript } from '../ai/media/store';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import voiceTranscriptBulkDelete from './voiceTranscriptBulkDelete';
import voiceTranscriptDelete from './voiceTranscriptDelete';

type DeletedMessage = Parameters<typeof voiceTranscriptDelete.execute>[0];
type BulkArgs = Parameters<typeof voiceTranscriptBulkDelete.execute>;

function fakeChannel(failFor: string[] = []) {
  const deleted: string[] = [];
  const channel = {
    id: 'main',
    messages: {
      async delete(id: string) {
        if (failFor.includes(id)) throw new Error('Unknown Message');
        deleted.push(id);
      },
    },
  };
  return { channel, deleted };
}

function deletedMessage(id: string, channel: unknown, authorId: string | null = 'user-1'): DeletedMessage {
  return {
    id,
    author: authorId ? { id: authorId } : null,
    client: { user: { id: 'bot-1' } },
    channel,
  } as unknown as DeletedMessage;
}

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setBotDbForTesting(undefined);
});

describe('voice transcript deletion', () => {
  it("deletes every transcript reply to a deleted voice message and forgets all of its recordings' text", async () => {
    rememberTranscriptReply('reply-1', 'voice-1');
    rememberTranscriptReply('reply-2', 'voice-1');
    rememberTranscriptReply('reply-other', 'voice-2');
    storeTranscript('voice-1', 'on joue ce soir?', 'm');
    storeTranscript('voice-1:att-2', 'ouais vers 9h', 'm');
    storeTranscript('voice-10', 'another message whose id starts the same', 'm');
    storeTranscript('voice-2', 'kept', 'm');
    const { channel, deleted } = fakeChannel();

    await voiceTranscriptDelete.execute(deletedMessage('voice-1', channel));

    expect(deleted.sort()).toEqual(['reply-1', 'reply-2']);
    expect(getStoredTranscript('voice-1')).toBeUndefined();
    expect(getStoredTranscript('voice-1:att-2')).toBeUndefined();
    expect(getStoredTranscript('voice-10')).toBe('another message whose id starts the same');
    expect(getStoredTranscript('voice-2')).toBe('kept');
  });

  it('does nothing for a message without a transcript, and survives a reply that is already gone', async () => {
    const { channel, deleted } = fakeChannel(['reply-1']);
    await voiceTranscriptDelete.execute(deletedMessage('plain-1', channel, null));
    expect(deleted).toEqual([]);

    rememberTranscriptReply('reply-1', 'voice-1');
    rememberTranscriptReply('reply-2', 'voice-1');
    await voiceTranscriptDelete.execute(deletedMessage('voice-1', channel));
    expect(deleted).toEqual(['reply-2']);
    // Still known as a transcript reply: if it is still up, it keeps reading as one.
    expect(isStoredTranscriptReply('reply-1')).toBe(true);
  });

  it('handles purges, without deleting replies the purge already took', async () => {
    rememberTranscriptReply('reply-1', 'voice-1');
    rememberTranscriptReply('reply-2', 'voice-2');
    storeTranscript('voice-2', 'purged', 'm');
    const { channel, deleted } = fakeChannel();
    const purged = new Collection<string, Message>([
      ['voice-1', {} as Message],
      ['reply-1', {} as Message],
      ['voice-2', {} as Message],
    ]);

    await voiceTranscriptBulkDelete.execute(...([purged, channel] as unknown as BulkArgs));

    expect(deleted).toEqual(['reply-2']);
    expect(getStoredTranscript('voice-2')).toBeUndefined();
  });
});
