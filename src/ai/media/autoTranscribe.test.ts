import { ChannelType, MessageFlags } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import { type FakeMessageOptions, createFakeMessage } from '../../test-support/fakeDiscord';
import {
  TOO_LONG_HEADER,
  TRANSCRIPT_HEADER,
  VoiceAutoTranscriber,
  type VoiceAutoTranscriberOptions,
  formatTooLongNote,
  formatTranscriptReply,
  isTranscriptReply,
  isTranscriptReplyId,
} from './autoTranscribe';
import type { AudioInput, TranscriptionOutcome } from './types';

const VOICE_URL = 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg';

function setup(outcome: TranscriptionOutcome, overrides: Partial<VoiceAutoTranscriberOptions> = {}) {
  const asked: AudioInput[] = [];
  const transcriber = new VoiceAutoTranscriber({
    transcribe: async (input) => {
      asked.push(input);
      return outcome;
    },
    enabled: () => true,
    channels: () => [],
    ...overrides,
  });
  return { transcriber, asked };
}

function voice(opts: FakeMessageOptions = {}) {
  return createFakeMessage({
    messageId: 'voice-1',
    flags: MessageFlags.IsVoiceMessage,
    attachments: [{ url: VOICE_URL, contentType: 'audio/ogg', duration: 7 }],
    ...opts,
  });
}

const OK: TranscriptionOutcome = { status: 'ok', text: 'on joue ce soir?\nEnglish: are we playing tonight?', cached: false };

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setBotDbForTesting(undefined);
});

describe('VoiceAutoTranscriber', () => {
  it("replies to a member's voice message with a silent, ping-free transcript", async () => {
    const { transcriber, asked } = setup(OK);
    const { message, recorders } = voice();

    expect(await transcriber.handle(message)).toBe('posted');

    expect(asked).toEqual([{ url: VOICE_URL, contentType: 'audio/ogg', messageId: 'voice-1', durationSecs: 7 }]);
    expect(recorders.reply.calls).toEqual([
      [
        {
          content: `${TRANSCRIPT_HEADER}\n> on joue ce soir?\n> English: are we playing tonight?`,
          allowedMentions: { parse: [], repliedUser: false },
          flags: MessageFlags.SuppressNotifications,
        },
      ],
    ]);
  });

  it('leaves uploaded audio files alone (only real voice messages get a transcript reply)', async () => {
    const { transcriber, asked } = setup({ status: 'ok', text: 'la la la', cached: false });
    const { message, recorders } = createFakeMessage({
      attachments: [{ url: 'https://cdn.discordapp.com/a/b/song.mp3', contentType: 'audio/mpeg', name: 'song.mp3' }],
    });
    expect(await transcriber.handle(message)).toBe('skipped');
    expect(asked).toEqual([]);
    expect(recorders.reply.calls).toEqual([]);
  });

  it('posts a short, silent note for a voice message over VOICE_MAX_SECONDS', async () => {
    const { transcriber } = setup({ status: 'too_long', durationSecs: 754 });
    const { message, recorders } = voice({ replyImpl: async () => ({ id: 'note-1' }) });

    expect(await transcriber.handle(message)).toBe('posted');

    expect(recorders.reply.calls).toEqual([
      [
        {
          content: '-# 🎙️ too long to transcribe (12:34)',
          allowedMentions: { parse: [], repliedUser: false },
          flags: MessageFlags.SuppressNotifications,
        },
      ],
    ]);
    expect(isTranscriptReplyId('note-1')).toBe(true);
  });

  it('remembers the ids of its transcript replies', async () => {
    const { transcriber } = setup(OK);
    const { message } = voice({ replyImpl: async () => ({ id: 'reply-1' }) });
    await transcriber.handle(message);
    expect(isTranscriptReplyId('reply-1')).toBe(true);
    expect(isTranscriptReplyId('some-other-message')).toBe(false);
  });

  it('works in threads, and in a thread whose parent is on the allowlist', async () => {
    const { transcriber } = setup(OK, { channels: () => ['main-channel'] });
    const inThread = voice({ channelType: ChannelType.PublicThread, channelId: 'thread-9', channelParentId: 'main-channel' });
    expect(await transcriber.handle(inThread.message)).toBe('posted');
  });

  it('only posts in allowlisted channels when VOICE_TRANSCRIBE_CHANNELS is set', async () => {
    const { transcriber, asked } = setup(OK, { channels: () => ['main-channel'] });
    expect(await transcriber.handle(voice({ channelId: 'main-channel' }).message)).toBe('posted');
    expect(await transcriber.handle(voice({ channelId: 'clips' }).message)).toBe('skipped');
    expect(asked).toHaveLength(1);
  });

  it.each<[string, FakeMessageOptions]>([
    ['bots', { authorIsBot: true }],
    ['webhooks (including its own reposts)', { webhookId: 'wh-1' }],
    ['DMs', { channelType: ChannelType.DM }],
    ['messages without audio', { flags: 0, attachments: [{ url: 'https://cdn.discordapp.com/a/b/p.png', contentType: 'image/png' }] }],
  ])('skips %s', async (_label, opts) => {
    const { transcriber, asked } = setup(OK);
    const { message, recorders } = voice(opts);
    expect(await transcriber.handle(message)).toBe('skipped');
    expect(asked).toEqual([]);
    expect(recorders.reply.calls).toEqual([]);
  });

  it('does nothing when VOICE_AUTO_TRANSCRIBE is off', async () => {
    const { transcriber, asked } = setup(OK, { enabled: () => false });
    expect(await transcriber.handle(voice().message)).toBe('skipped');
    expect(asked).toEqual([]);
  });

  it.each<TranscriptionOutcome>([
    { status: 'ok', text: '', cached: false },
    { status: 'failed' },
    { status: 'unavailable' },
  ])('posts nothing without a transcript (%o)', async (outcome) => {
    const { transcriber } = setup(outcome);
    const { message, recorders } = voice();
    expect(await transcriber.handle(message)).toBe('nothing');
    expect(recorders.reply.calls).toEqual([]);
  });

  it('survives a reply that Discord refuses (deleted message, missing permission)', async () => {
    const { transcriber } = setup(OK);
    const { message } = voice({
      replyImpl: async () => {
        throw new Error('Unknown Message');
      },
    });
    expect(await transcriber.handle(message)).toBe('nothing');
  });
});

describe('formatTranscriptReply', () => {
  it('escapes markdown so spoken symbols stay text', () => {
    const [reply] = formatTranscriptReply('# not a heading\n- first speaker\n*this* is __it__ [x](https://e.x)');
    expect(reply).toBe(
      `${TRANSCRIPT_HEADER}\n> \\# not a heading\n> \\- first speaker\n> \\*this\\* is \\_\\_it\\_\\_ \\[x](https://e.x)`,
    );
  });

  it('splits long transcripts into quoted messages under 2000 characters', () => {
    const words = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ');
    const chunks = formatTranscriptReply(words);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      for (const line of chunk.split('\n').filter((l) => l !== TRANSCRIPT_HEADER)) {
        expect(line.startsWith('>')).toBe(true);
      }
    }
    expect(chunks[0].startsWith(TRANSCRIPT_HEADER)).toBe(true);
  });

  it('cuts runaway transcripts after five messages', () => {
    const chunks = formatTranscriptReply(Array.from({ length: 200 }, () => 'x'.repeat(100)).join('\n'));
    expect(chunks).toHaveLength(5);
    expect(chunks[4].endsWith('-# (transcript cut short)')).toBe(true);
    expect(chunks[4].length).toBeLessThanOrEqual(2000);
  });
});

describe('isTranscriptReply', () => {
  it("recognizes the bot's own transcript replies only", () => {
    const own = createFakeMessage({ authorId: 'bot-1', botUserId: 'bot-1', content: `${TRANSCRIPT_HEADER}\n> hi` });
    const quoted = createFakeMessage({ authorId: 'user-2', botUserId: 'bot-1', content: `${TRANSCRIPT_HEADER}\n> hi` });
    const normal = createFakeMessage({ authorId: 'bot-1', botUserId: 'bot-1', content: 'hey' });
    const note = createFakeMessage({ authorId: 'bot-1', botUserId: 'bot-1', content: formatTooLongNote(700) });
    expect(isTranscriptReply(own.message)).toBe(true);
    expect(isTranscriptReply(note.message)).toBe(true);
    expect(formatTooLongNote(700).startsWith(TOO_LONG_HEADER)).toBe(true);
    expect(isTranscriptReply(quoted.message)).toBe(false);
    expect(isTranscriptReply(normal.message)).toBe(false);
  });
});
