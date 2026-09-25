import { MessageFlags } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordRelay } from '../../relay';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import {
  audioAttachments,
  formatClock,
  isVoiceMessage,
  speakerName,
  transcriptKey,
  videoAttachments,
} from './voice';

const VOICE = { url: 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg', contentType: 'audio/ogg' };

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setBotDbForTesting(undefined);
});

describe('voice message detection', () => {
  it('reads the IsVoiceMessage flag', () => {
    expect(isVoiceMessage(createFakeMessage({ flags: MessageFlags.IsVoiceMessage }).message)).toBe(true);
    expect(isVoiceMessage(createFakeMessage({ attachments: [VOICE] }).message)).toBe(false);
  });

  it('treats audio/* attachments as audio, with or without the voice flag', () => {
    const { message } = createFakeMessage({
      attachments: [
        VOICE,
        { url: 'https://cdn.discordapp.com/a/b/memo.mp3', contentType: 'audio/mpeg; charset=binary' },
        { url: 'https://cdn.discordapp.com/a/b/pic.png', contentType: 'image/png' },
        { url: 'https://cdn.discordapp.com/a/b/clip.mp4', contentType: 'video/mp4' },
      ],
    });
    expect(audioAttachments(message).map((a) => a.url)).toEqual([VOICE.url, 'https://cdn.discordapp.com/a/b/memo.mp3']);
    expect(videoAttachments(message).map((a) => a.url)).toEqual(['https://cdn.discordapp.com/a/b/clip.mp4']);
  });

  it("counts a voice message's attachment even when Discord left the content type off", () => {
    const untyped = { url: VOICE.url, contentType: null };
    expect(audioAttachments(createFakeMessage({ flags: MessageFlags.IsVoiceMessage, attachments: [untyped] }).message)).toHaveLength(1);
    expect(audioAttachments(createFakeMessage({ attachments: [untyped] }).message)).toHaveLength(0);
  });
});

describe('transcriptKey', () => {
  it('keys the first recording by the message id alone (what getCachedTranscript reads)', () => {
    expect(transcriptKey('m1', 'a1', 0)).toBe('m1');
    expect(transcriptKey('m1', 'a2', 1)).toBe('m1:a2');
  });
});

describe('formatClock', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(4.6)).toBe('0:05');
    expect(formatClock(62)).toBe('1:02');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-3)).toBe('0:00');
  });
});

describe('speakerName', () => {
  it("uses the member's display name", () => {
    expect(speakerName(createFakeMessage({ authorDisplayName: 'Wheelie' }).message)).toBe('Wheelie');
  });

  it('credits a relayed message to the member it was posted for', () => {
    recordRelay({ messageId: 'relay-1', channelId: 'c', authorId: 'u9', authorName: 'Jasper', kind: 'link_fix' });
    const { message } = createFakeMessage({ messageId: 'relay-1', webhookId: 'wh-1', authorUsername: 'Jasper (webhook)' });
    expect(speakerName(message)).toBe('Jasper');
  });
});
