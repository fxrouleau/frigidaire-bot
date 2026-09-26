import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test-support/openRouterFetch';
import type { TaggedUsageEntry } from '../usage';
import { createUsageTrackingFetch, flushPendingUsage } from '../usageFetch';
import { type SttResponse, cleanSttTranscript, isHallucinatedPhrase, normalizePhrase, requestTranscription } from './speechToText';

const verbose = loadFixture('stt-whisper-verbose');
const silence = loadFixture('stt-whisper-silence');
const plain = loadFixture('stt-whisper-plain');

describe('normalizePhrase', () => {
  it('lowercases, unifies apostrophes and trims outer punctuation', () => {
    expect(normalizePhrase(' Merci d’avoir regardé ! ')).toBe("merci d'avoir regardé");
    expect(normalizePhrase('«Thanks for watching!»')).toBe('thanks for watching');
  });
});

describe('isHallucinatedPhrase', () => {
  it.each([
    "Sous-titres réalisés par la communauté d'Amara.org",
    'Sous-titrage ST’ 501',
    'Sous-titrage Société Radio-Canada',
    'Subtitles by the Amara.org community',
    'Thanks for watching!',
    'Thank you for watching.',
    "Merci d'avoir regardé !",
    'Merci d’avoir regardé cette vidéo.',
    'Untertitel der Amara.org-Community',
    'Subtítulos realizados por la comunidad de Amara.org',
    'ご視聴ありがとうございました',
  ])('drops %s', (phrase) => {
    expect(isHallucinatedPhrase(phrase)).toBe(true);
  });

  it.each(['Thank you.', 'merci', 'on regarde le film ce soir?', "thanks for watching my dog, I'll be back at 6"])(
    'keeps %s',
    (phrase) => {
      expect(isHallucinatedPhrase(phrase)).toBe(false);
    },
  );
});

describe('cleanSttTranscript', () => {
  it('drops outro credits and segments Whisper itself scores as silence', () => {
    expect(cleanSttTranscript(verbose.response as SttResponse)).toBe(
      "Salut tout le monde, on se fait une game ce soir ? Genre vers 21 h, j'amène les chips.",
    );
  });

  it('reduces a clip that is only a subtitle credit to silence', () => {
    expect(cleanSttTranscript(silence.response as SttResponse)).toBe('');
  });

  it('filters sentence by sentence when the host returns no segments', () => {
    expect(cleanSttTranscript(plain.response as SttResponse)).toBe('Salut tout le monde, on se fait une game ce soir ?');
  });

  it('keeps "thank you" when it was clearly spoken, drops it over silence', () => {
    const segment = (no_speech_prob: number) => ({ text: ' Thank you.', no_speech_prob, avg_logprob: -0.3 });
    expect(cleanSttTranscript({ segments: [segment(0.05)] })).toBe('Thank you.');
    expect(cleanSttTranscript({ segments: [segment(0.7)] })).toBe('');
  });

  it('keeps segments from hosts that report no scores', () => {
    expect(cleanSttTranscript({ segments: [{ text: ' you' }, { text: ' know what I mean' }] })).toBe(
      'you know what I mean',
    );
  });

  it('treats a response without any text as a failure, an empty one as silence', () => {
    expect(cleanSttTranscript({ usage: { seconds: 2 } })).toBeUndefined();
    expect(cleanSttTranscript({ text: '' })).toBe('');
  });

  it('caps runaway output', () => {
    const text = cleanSttTranscript({ text: 'a'.repeat(20_000) });
    expect(text?.length).toBe(12_001);
  });
});

describe('requestTranscription', () => {
  it('posts base64 audio to /audio/transcriptions, and the usage ledger books its cost', async () => {
    const recorded: TaggedUsageEntry[] = [];
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    const inner = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(verbose.response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://openrouter.ai/api/v1',
      maxRetries: 0,
      fetch: createUsageTrackingFetch(inner as typeof globalThis.fetch, {
        record: (entry) => recorded.push(entry),
        isEnabled: () => true,
      }),
    });

    const audio = Buffer.from('OggS-voice');
    const response = await requestTranscription({
      client,
      model: 'openai/whisper-large-v3',
      data: audio,
      format: 'ogg',
      timeoutMs: 5000,
    });
    await flushPendingUsage();

    expect(response.text).toContain('Salut tout le monde');
    expect(requests[0].url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(requests[0].body).toEqual({
      model: 'openai/whisper-large-v3',
      input_audio: { data: audio.toString('base64'), format: 'ogg' },
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });
    // The internal feature tag never leaves the process.
    expect(requests[0].headers.has('x-frigidaire-feature')).toBe(false);
    // No `model` in an STT response: the ledger takes it from the request, and the cost from usage.cost.
    expect(recorded).toEqual([
      expect.objectContaining({ feature: 'transcription', model: 'openai/whisper-large-v3', cost: 0.00007065 }),
    ]);
  });

  it('asks for the plain json form when verbose is off', async () => {
    let body: Record<string, unknown> = {};
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://openrouter.ai/api/v1',
      maxRetries: 0,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(plain.response), { headers: { 'content-type': 'application/json' } });
      }) as typeof globalThis.fetch,
    });
    await requestTranscription({ client, model: 'm', data: Buffer.from('x'), format: 'mp3', timeoutMs: 1000, verbose: false });
    expect(body.response_format).toBeUndefined();
    expect(body.timestamp_granularities).toBeUndefined();
  });
});
