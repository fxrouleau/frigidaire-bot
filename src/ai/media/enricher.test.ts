import { MessageFlags } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import { createMediaEnricher, type MediaEnricherDeps, mediaEnricher } from './enricher';
import { storeTranscript } from './store';
import type { AudioInput, TranscriptionOutcome, VideoInput, VideoOutcome } from './types';

const VOICE_URL = 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg';
const CLIP_URL = 'https://cdn.discordapp.com/attachments/1/3/clip.mp4';

function fakeDeps(
  opts: {
    transcript?: TranscriptionOutcome;
    video?: VideoOutcome;
    cachedTranscripts?: Record<string, string>;
    cachedDescriptions?: Record<string, string>;
  } = {},
) {
  const transcribed: AudioInput[] = [];
  const described: VideoInput[] = [];
  const deps: MediaEnricherDeps = {
    transcribe: async (input) => {
      transcribed.push(input);
      return opts.transcript ?? { status: 'ok', text: 'yo who is on tonight', cached: false };
    },
    cachedTranscript: (key) => opts.cachedTranscripts?.[key],
    describe: async (input) => {
      described.push(input);
      return opts.video ?? { status: 'ok', text: 'A cat knocks a glass off a table.', cached: false };
    },
    cachedDescription: (url) => opts.cachedDescriptions?.[url],
  };
  return { deps, transcribed, described };
}

function voiceMessage(extra: Parameters<typeof createFakeMessage>[0] = {}) {
  return createFakeMessage({
    messageId: 'voice-1',
    authorDisplayName: 'Remi',
    flags: MessageFlags.IsVoiceMessage,
    attachments: [{ url: VOICE_URL, contentType: 'audio/ogg', duration: 42.3 }],
    ...extra,
  }).message;
}

describe('media enricher', () => {
  it('adds nothing to messages without audio or video', async () => {
    const { deps, transcribed } = fakeDeps();
    const { message } = createFakeMessage({
      content: 'hello',
      attachments: [{ url: 'https://cdn.discordapp.com/a/b/pic.png', contentType: 'image/png' }],
    });
    expect(await createMediaEnricher(deps).enrich(message, 'current')).toEqual([]);
    expect(transcribed).toEqual([]);
  });

  it('transcribes the triggering voice message and labels it with speaker and length', async () => {
    const { deps, transcribed } = fakeDeps();

    const parts = await createMediaEnricher(deps).enrich(voiceMessage(), 'current');

    expect(parts).toEqual([{ type: 'text', text: '[voice message from Remi, 0:42: yo who is on tonight]' }]);
    expect(transcribed).toEqual([
      { url: VOICE_URL, contentType: 'audio/ogg', messageId: 'voice-1', durationSecs: 42.3 },
    ]);
  });

  it('transcribes the replied-to message too', async () => {
    const { deps, transcribed } = fakeDeps();
    await createMediaEnricher(deps).enrich(voiceMessage(), 'reference');
    expect(transcribed).toHaveLength(1);
  });

  it('only reads the cache for history, never paying for a backfill', async () => {
    const { deps, transcribed } = fakeDeps({ cachedTranscripts: { 'voice-1': 'already heard this one' } });
    const enricher = createMediaEnricher(deps);

    expect(await enricher.enrich(voiceMessage(), 'history')).toEqual([
      { type: 'text', text: '[voice message from Remi, 0:42: already heard this one]' },
    ]);
    expect(await enricher.enrich(voiceMessage({ messageId: 'voice-2' }), 'history')).toEqual([
      { type: 'text', text: '[voice message from Remi, 0:42 — not transcribed]' },
    ]);
    expect(transcribed).toEqual([]);
  });

  it.each([
    [{ status: 'ok', text: '', cached: false } as const, '[voice message from Remi, 0:42: (no speech)]'],
    [{ status: 'too_long', durationSecs: 900 } as const, '[voice message from Remi, 0:42 — too long to transcribe]'],
    [{ status: 'too_large' } as const, '[voice message from Remi, 0:42 — too large to transcribe]'],
    [{ status: 'failed' } as const, "[voice message from Remi, 0:42 — couldn't transcribe it]"],
    [{ status: 'unavailable' } as const, "[voice message from Remi, 0:42 — couldn't transcribe it]"],
  ])('leaves a marker when there is no transcript (%o)', async (outcome, expected) => {
    const { deps } = fakeDeps({ transcript: outcome });
    expect(await createMediaEnricher(deps).enrich(voiceMessage(), 'current')).toEqual([{ type: 'text', text: expected }]);
  });

  it('names audio files and keys each one separately', async () => {
    const { deps, transcribed } = fakeDeps();
    const { message } = createFakeMessage({
      messageId: 'm5',
      authorDisplayName: 'Silas',
      attachments: [
        { url: 'https://cdn.discordapp.com/a/b/one.mp3', contentType: 'audio/mpeg', name: 'one.mp3', id: 'a1' },
        { url: 'https://cdn.discordapp.com/a/b/two.m4a', contentType: 'audio/mp4', name: 'two.m4a', id: 'a2' },
      ],
    });

    const parts = await createMediaEnricher(deps).enrich(message, 'current');

    expect(parts.map((p) => (p.type === 'text' ? p.text : ''))).toEqual([
      '[audio file "one.mp3" from Silas: yo who is on tonight]',
      '[audio file "two.m4a" from Silas: yo who is on tonight]',
    ]);
    expect(transcribed.map((t) => t.messageId)).toEqual(['m5', 'm5:a2']);
  });

  it('caps paid work per message', async () => {
    const { deps, transcribed } = fakeDeps();
    const { message } = createFakeMessage({
      attachments: Array.from({ length: 5 }, (_, i) => ({
        url: `https://cdn.discordapp.com/a/b/${i}.mp3`,
        contentType: 'audio/mpeg',
      })),
    });
    expect(await createMediaEnricher(deps).enrich(message, 'current')).toHaveLength(3);
    expect(transcribed).toHaveLength(3);
  });

  it('describes a posted video, passing who posted it and what they said', async () => {
    const { deps, described } = fakeDeps();
    const { message } = createFakeMessage({
      authorDisplayName: 'Wheelie',
      content: 'LMAOOO look at him',
      attachments: [{ url: CLIP_URL, contentType: 'video/mp4', name: 'clip.mp4', duration: null }],
    });

    const parts = await createMediaEnricher(deps).enrich(message, 'current');

    expect(parts).toEqual([{ type: 'text', text: `[video msg:${message.id}: A cat knocks a glass off a table.]` }]);
    expect(described).toEqual([
      {
        url: CLIP_URL,
        contentType: 'video/mp4',
        context: 'Posted by Wheelie with the message: LMAOOO look at him',
        durationSecs: null,
      },
    ]);
  });

  it('marks videos it could not watch, and reads only the cache for history', async () => {
    const attachments = [{ url: CLIP_URL, contentType: 'video/mp4', name: 'clip.mp4' }];
    const posted = (extra = {}) => createFakeMessage({ messageId: 'clip-msg', attachments, ...extra }).message;
    const failed = fakeDeps({ video: { status: 'failed' } });
    expect(await createMediaEnricher(failed.deps).enrich(posted(), 'current')).toEqual([
      { type: 'text', text: "[video msg:clip-msg: clip.mp4 (couldn't watch it)]" },
    ]);

    const tooBig = fakeDeps({ video: { status: 'too_large' } });
    expect(await createMediaEnricher(tooBig.deps).enrich(posted(), 'current')).toEqual([
      { type: 'text', text: '[video msg:clip-msg: clip.mp4 (too large to watch)]' },
    ]);

    const broke = fakeDeps({ video: { status: 'over_budget' } });
    expect(await createMediaEnricher(broke.deps).enrich(posted(), 'current')).toEqual([
      {
        type: 'text',
        text: '[video msg:clip-msg: clip.mp4 (not watched: out of popcorn money for today, the daily video budget is spent)]',
      },
    ]);

    const history = fakeDeps({ cachedDescriptions: { [CLIP_URL]: 'A known clip.' } });
    const enricher = createMediaEnricher(history.deps);
    expect(await enricher.enrich(posted(), 'history')).toEqual([
      { type: 'text', text: '[video msg:clip-msg: A known clip.]' },
    ]);
    const other = [{ url: 'https://cdn.discordapp.com/a/b/other.mp4', contentType: 'video/mp4', name: 'other.mp4' }];
    expect(await enricher.enrich(posted({ attachments: other }), 'history')).toEqual([
      { type: 'text', text: '[video msg:clip-msg: other.mp4 (not watched)]' },
    ]);
    expect(history.described).toEqual([]);
  });

  it('gives each video on a message its own handle (msg:<id>, then msg:<id>#2)', async () => {
    const { deps } = fakeDeps();
    const { message } = createFakeMessage({
      messageId: 'two-clips',
      attachments: [
        { url: CLIP_URL, contentType: 'video/mp4', name: 'clip.mp4' },
        { url: 'https://cdn.discordapp.com/a/b/other.mp4', contentType: 'video/mp4', name: 'other.mp4' },
      ],
    });
    const texts = (await createMediaEnricher(deps).enrich(message, 'current')).map((p) =>
      p.type === 'text' ? p.text : '',
    );
    expect(texts).toEqual([
      '[video msg:two-clips: A cat knocks a glass off a table.]',
      '[video msg:two-clips#2: A cat knocks a glass off a table.]',
    ]);
  });

  it('renders audio before video when a message has both', async () => {
    const { deps } = fakeDeps();
    const { message } = createFakeMessage({
      authorDisplayName: 'Remi',
      attachments: [
        { url: CLIP_URL, contentType: 'video/mp4', name: 'clip.mp4' },
        { url: 'https://cdn.discordapp.com/a/b/memo.mp3', contentType: 'audio/mpeg', name: 'memo.mp3' },
      ],
    });
    const texts = (await createMediaEnricher(deps).enrich(message, 'current')).map((p) =>
      p.type === 'text' ? p.text : '',
    );
    expect(texts[0]).toMatch(/^\[audio file "memo.mp3" from Remi/);
    expect(texts[1]).toMatch(/^\[video msg:/);
  });
});

describe('default media enricher', () => {
  beforeEach(() => {
    setBotDbForTesting(new BotDb(':memory:'));
  });

  afterEach(() => {
    setBotDbForTesting(undefined);
  });

  it('reads transcripts other features already stored', async () => {
    storeTranscript('voice-1', 'stored by the auto-transcript', 'google/gemini-3.5-flash-lite');
    expect(await mediaEnricher.enrich(voiceMessage(), 'history')).toEqual([
      { type: 'text', text: '[voice message from Remi, 0:42: stored by the auto-transcript]' },
    ]);
  });
});
