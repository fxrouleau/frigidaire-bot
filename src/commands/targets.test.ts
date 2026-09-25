import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMemoryStoreForTesting } from '../ai/memory';
import { MemoryStore } from '../ai/memory/memoryStore';
import { recordRelay } from '../relay';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { createFakeCommandDeps, createFakeGuild, createFakeTargetMessage } from '../test-support/fakeInteraction';
import { LINES } from './respond';
import {
  ensureTargetChannel,
  formatDuration,
  invokerName,
  liveDisplayName,
  mediaAttachments,
  readableText,
  resolveTargetAuthor,
  transcriptOf,
  voiceTranscriptOf,
} from './targets';
import { CommandError } from './types';

let store: MemoryStore;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = new MemoryStore(':memory:');
  setMemoryStoreForTesting(store);
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setMemoryStoreForTesting(undefined);
  setBotDbForTesting(undefined);
  vi.restoreAllMocks();
});

describe('mediaAttachments', () => {
  it('reads a voice message as audio, with its duration', () => {
    const { message } = createFakeTargetMessage({
      voiceMessage: true,
      mediaAttachments: [{ url: 'https://cdn/voice-message.ogg', contentType: 'audio/ogg', duration: 42.3 }],
    });
    expect(mediaAttachments(message)).toEqual([
      {
        kind: 'audio',
        url: 'https://cdn/voice-message.ogg',
        name: 'file-0',
        contentType: 'audio/ogg',
        durationSecs: 42.3,
        voice: true,
      },
    ]);
  });

  it('classifies audio and video files by content type, falling back to the extension', () => {
    const { message } = createFakeTargetMessage({
      mediaAttachments: [
        { url: 'https://cdn/a.mp3', contentType: 'audio/mpeg', name: 'song.mp3' },
        { url: 'https://cdn/b.mp4', contentType: 'video/mp4; codecs=avc1', name: 'clip.mp4' },
        { url: 'https://cdn/c', contentType: null, name: 'memo.m4a' },
        { url: 'https://cdn/d', contentType: null, name: 'thing.MOV' },
        { url: 'https://cdn/e.png', contentType: 'image/png', name: 'pic.png' },
        { url: 'https://cdn/f', contentType: null, name: 'notes.txt' },
      ],
    });
    expect(mediaAttachments(message).map((m) => [m.name, m.kind, m.voice])).toEqual([
      ['song.mp3', 'audio', false],
      ['clip.mp4', 'video', false],
      ['memo.m4a', 'audio', false],
      ['thing.MOV', 'video', false],
    ]);
  });

  it('finds nothing on a plain text message', () => {
    expect(mediaAttachments(createFakeTargetMessage({ content: 'hi' }).message)).toEqual([]);
  });
});

describe('transcriptOf / voiceTranscriptOf', () => {
  const voice = () =>
    createFakeTargetMessage({
      messageId: 'voice-1',
      voiceMessage: true,
      mediaAttachments: [{ url: 'https://cdn/v.ogg', contentType: 'audio/ogg', duration: 5 }],
    }).message;

  it('uses the cached transcript without paying for a new one', async () => {
    const { deps, recorders } = createFakeCommandDeps({ getCachedTranscript: () => '  cached words  ' });
    expect(await voiceTranscriptOf(voice(), deps)).toBe('cached words');
    expect(recorders.getCachedTranscript.calls).toEqual([['voice-1']]);
    expect(recorders.transcribeAudio.calls).toHaveLength(0);
  });

  it('transcribes (keyed by message id) when nothing is cached', async () => {
    const { deps, recorders } = createFakeCommandDeps({ transcribeAudio: async () => 'fresh words' });
    expect(await voiceTranscriptOf(voice(), deps)).toBe('fresh words');
    expect(recorders.transcribeAudio.calls[0][0]).toEqual({
      url: 'https://cdn/v.ogg',
      contentType: 'audio/ogg',
      messageId: 'voice-1',
      durationSecs: 5,
    });
  });

  it('does not use the per-message cache when the message carries several audio files', async () => {
    const message = createFakeTargetMessage({
      mediaAttachments: [
        { url: 'https://cdn/1.mp3', contentType: 'audio/mpeg' },
        { url: 'https://cdn/2.mp3', contentType: 'audio/mpeg' },
      ],
    }).message;
    const { deps, recorders } = createFakeCommandDeps({ transcribeAudio: async () => 'x' });
    const [first] = mediaAttachments(message);
    await transcriptOf(message, first, deps, false);
    expect(recorders.getCachedTranscript.calls).toHaveLength(0);
    expect(recorders.transcribeAudio.calls[0][0].messageId).toBeUndefined();
  });

  it('reads a throwing or blank transcription as no transcript', async () => {
    const throwing = createFakeCommandDeps({
      transcribeAudio: async () => {
        throw new Error('model down');
      },
    });
    expect(await voiceTranscriptOf(voice(), throwing.deps)).toBeUndefined();
    const blank = createFakeCommandDeps({ transcribeAudio: async () => '   ' });
    expect(await voiceTranscriptOf(voice(), blank.deps)).toBeUndefined();
  });

  it('is undefined for a message without audio', async () => {
    const { deps, recorders } = createFakeCommandDeps();
    expect(await voiceTranscriptOf(createFakeTargetMessage({ content: 'hi' }).message, deps)).toBeUndefined();
    expect(recorders.transcribeAudio.calls).toHaveLength(0);
  });
});

describe('ensureTargetChannel', () => {
  it('does nothing when the channel is cached', async () => {
    const { message, recorders } = createFakeTargetMessage();
    await ensureTargetChannel(message);
    expect(recorders.channelsFetch.calls).toHaveLength(0);
  });

  it('fetches an uncached channel so message.channel resolves', async () => {
    const { message, recorders } = createFakeTargetMessage({ channelUncached: true, channelId: 'thread-9' });
    await ensureTargetChannel(message);
    expect(recorders.channelsFetch.calls).toEqual([['thread-9']]);
    expect(message.channel).not.toBeNull();
  });

  it('gives up with a readable CommandError when the channel cannot be fetched', async () => {
    const { message } = createFakeTargetMessage({ channelUncached: true, channelFetchFails: true });
    const error = await ensureTargetChannel(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).userMessage).toBe(LINES.noChannel);
  });
});

describe('resolveTargetAuthor', () => {
  it("uses a human author's live server name", async () => {
    const { guild, recorders } = createFakeGuild({ members: { 'user-7': 'Jason (live)' } });
    const { message } = createFakeTargetMessage({
      authorId: 'user-7',
      authorDisplayName: 'Jason',
      authorUsername: 'cigalefourmi',
      guild,
    });
    expect(await resolveTargetAuthor(message)).toEqual({ id: 'user-7', name: 'Jason (live)', username: 'cigalefourmi' });
    expect(recorders.membersFetch.calls).toEqual([['user-7']]);
  });

  it('falls back to the message name when the member left the server', async () => {
    const { guild } = createFakeGuild();
    const { message } = createFakeTargetMessage({ authorId: 'user-7', authorDisplayName: 'Jason', guild });
    expect(await resolveTargetAuthor(message)).toEqual({ id: 'user-7', name: 'Jason', username: 'testuser' });
  });

  it('credits a link-fix repost to the member it was posted for', async () => {
    recordRelay({ messageId: 'relay-1', channelId: 'channel-1', authorId: 'user-8', authorName: 'Simon', kind: 'link_fix' });
    const { guild } = createFakeGuild({ members: { 'user-8': 'Simon B' } });
    const { message } = createFakeTargetMessage({ messageId: 'relay-1', webhookId: 'hook-1', authorUsername: 'Simon', guild });
    // No username: the message's author is the webhook, whose "username" is only the name it posted under.
    expect(await resolveTargetAuthor(message)).toEqual({ id: 'user-8', name: 'Simon B' });
  });

  it('is undefined for bots and foreign webhooks', async () => {
    expect(await resolveTargetAuthor(createFakeTargetMessage({ authorIsBot: true }).message)).toBeUndefined();
    expect(
      await resolveTargetAuthor(createFakeTargetMessage({ webhookId: 'hook-x', applicationId: 'someone-else' }).message),
    ).toBeUndefined();
  });

  it("credits a linked side account's message to the main account, under the main account's live name", async () => {
    vi.stubEnv('LINKED_ACCOUNTS', '100000000000000002:100000000000000001');
    try {
      const { guild, recorders } = createFakeGuild({ members: { '100000000000000001': 'Tony' } });
      const { message } = createFakeTargetMessage({
        authorId: '100000000000000002',
        authorDisplayName: 'Ptoughneigh',
        authorUsername: 'triceclone',
        guild,
      });
      expect(await resolveTargetAuthor(message)).toEqual({ id: '100000000000000001', name: 'Tony', username: 'triceclone' });
      expect(recorders.membersFetch.calls).toEqual([['100000000000000001']]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('small helpers', () => {
  it('liveDisplayName is undefined without a guild', async () => {
    expect(await liveDisplayName(null, 'user-1')).toBeUndefined();
  });

  it('invokerName prefers the server member name, then the nick, then the user', () => {
    expect(invokerName({ member: null, user: { displayName: 'Global' } })).toBe('Global');
    expect(
      invokerName({
        member: { displayName: 'Server Name' } as unknown as Parameters<typeof invokerName>[0]['member'],
        user: { displayName: 'Global' },
      }),
    ).toBe('Server Name');
    expect(
      invokerName({
        member: { nick: 'Nick', user: { id: '1' } } as unknown as Parameters<typeof invokerName>[0]['member'],
        user: { displayName: 'Global' },
      }),
    ).toBe('Nick');
  });

  it('readableText uses the mention-resolved text', () => {
    const { message } = createFakeTargetMessage({ content: 'hi <@1>', cleanContent: 'hi @Jason' });
    expect(readableText(message)).toBe('hi @Jason');
  });

  it('formats durations as m:ss', () => {
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(65.4)).toBe('1:05');
    expect(formatDuration(600)).toBe('10:00');
  });
});
