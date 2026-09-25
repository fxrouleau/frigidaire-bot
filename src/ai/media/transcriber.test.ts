import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import {
  MP3_BYTES,
  OGG_BYTES,
  TRANSCODED_MP3,
  createCapturingClient,
  createFakeTranscoder,
  createFileFetch,
  type FakeTranscoder,
  createMissingTranscoder,
  userContent,
} from '../../test-support/fakeMedia';
import { type OpenRouterFixture, loadFixture } from '../../test-support/openRouterFetch';
import { FEATURE_HEADER } from '../usage';
import { getStoredTranscript } from './store';
import { AudioTranscriber, type AudioTranscriberOptions, cleanTranscript } from './transcriber';

const VOICE_URL = 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg?ex=1&hm=sig';
const MP3_URL = 'https://cdn.discordapp.com/attachments/1/3/memo.mp3';
const MODEL = 'google/gemini-3.5-flash-lite';

const success = loadFixture('transcription-success');
const noSpeech = loadFixture('transcription-no-speech');
const rejected = loadFixture('audio-format-rejected');
const serverError = loadFixture('http-500-error');
const TRANSCRIPT = 'salut tout le monde, on se fait une game ce soir?\nEnglish: hi everyone, are we playing a game tonight?';

const files = createFileFetch({
  [VOICE_URL]: { body: OGG_BYTES, contentType: 'audio/ogg' },
  [MP3_URL]: { body: MP3_BYTES, contentType: 'audio/mpeg' },
});

type SetupOverrides = Partial<Omit<AudioTranscriberOptions, 'transcoder'>> & { transcoder?: FakeTranscoder };

function setup(fixtures: OpenRouterFixture[], overrides: SetupOverrides = {}) {
  const { client, requests } = createCapturingClient(fixtures);
  const transcoder = overrides.transcoder ?? createFakeTranscoder();
  let now = 1_000_000;
  const transcriber = new AudioTranscriber({
    client: () => client,
    fetch: files,
    model: () => MODEL,
    maxSeconds: () => 600,
    now: () => now,
    ...overrides,
    transcoder,
  });
  return {
    transcriber,
    requests,
    transcoder,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  files.urls.length = 0;
});

afterEach(() => {
  setBotDbForTesting(undefined);
});

describe('AudioTranscriber', () => {
  it('transcodes a Discord voice message to MP3 and sends it with ZDR routing and the transcription tag', async () => {
    const { transcriber, requests, transcoder } = setup([success]);

    const outcome = await transcriber.transcribe({
      url: VOICE_URL,
      contentType: 'audio/ogg',
      messageId: 'msg-1',
      durationSecs: 4.2,
    });

    expect(outcome).toEqual({ status: 'ok', text: TRANSCRIPT, cached: false });
    expect(transcoder.calls.toMp3).toEqual([{ input: OGG_BYTES, maxSeconds: 600 }]);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(request.body.model).toBe(MODEL);
    expect(request.body.provider).toEqual({ zdr: true });
    expect(request.body.temperature).toBeUndefined();
    expect(request.headers[FEATURE_HEADER.toLowerCase()]).toBe('transcription');
    const [audio, prompt] = userContent(request);
    expect(audio).toEqual({
      type: 'input_audio',
      input_audio: { data: TRANSCODED_MP3.toString('base64'), format: 'mp3' },
    });
    expect(prompt.type).toBe('text');
    expect(String(prompt.text)).toContain('English: ');
  });

  it('caches by message id: the second ask is free', async () => {
    const { transcriber, requests } = setup([success]);
    await transcriber.transcribe({ url: VOICE_URL, messageId: 'msg-1' });

    const again = await transcriber.transcribe({ url: VOICE_URL, messageId: 'msg-1' });

    expect(again).toEqual({ status: 'ok', text: TRANSCRIPT, cached: true });
    expect(requests).toHaveLength(1);
    expect(transcriber.cached('msg-1')).toBe(TRANSCRIPT);
    expect(getStoredTranscript('msg-1')).toBe(TRANSCRIPT);
  });

  it('does not persist transcripts that have no message id', async () => {
    const { transcriber } = setup([success]);
    await transcriber.transcribe({ url: VOICE_URL });
    expect(getStoredTranscript('msg-1')).toBeUndefined();
  });

  it('sends formats the model takes as-is, without transcoding', async () => {
    const { transcriber, requests, transcoder } = setup([success]);

    await transcriber.transcribe({ url: MP3_URL, contentType: 'audio/mpeg', messageId: 'msg-2', durationSecs: 30 });

    expect(transcoder.calls.toMp3).toHaveLength(0);
    expect(userContent(requests[0])[0]).toEqual({
      type: 'input_audio',
      input_audio: { data: MP3_BYTES.toString('base64'), format: 'mp3' },
    });
  });

  it('records a recording without speech as an empty transcript', async () => {
    const { transcriber } = setup([noSpeech]);
    expect(await transcriber.transcribe({ url: VOICE_URL, messageId: 'msg-3' })).toEqual({
      status: 'ok',
      text: '',
      cached: false,
    });
    expect(getStoredTranscript('msg-3')).toBe('');
  });

  it('refuses recordings over VOICE_MAX_SECONDS before downloading anything', async () => {
    const { transcriber, requests } = setup([success]);
    expect(await transcriber.transcribe({ url: VOICE_URL, messageId: 'm', durationSecs: 601 })).toEqual({
      status: 'too_long',
      durationSecs: 601,
    });
    expect(files.urls).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('probes the length of a native-format file that has no Discord duration', async () => {
    const transcoder = createFakeTranscoder({ probe: { durationSecs: 1200, hasAudio: true, hasVideo: false } });
    const { transcriber, requests } = setup([success], { transcoder });
    expect(await transcriber.transcribe({ url: MP3_URL, messageId: 'm' })).toEqual({
      status: 'too_long',
      durationSecs: 1200,
    });
    expect(requests).toHaveLength(0);
  });

  it('uses the source length the transcoder reports for transcoded files', async () => {
    const transcoder = createFakeTranscoder({ toMp3: { data: TRANSCODED_MP3, durationSecs: 900 } });
    const { transcriber, requests } = setup([success], { transcoder });
    expect(await transcriber.transcribe({ url: VOICE_URL, messageId: 'm' })).toEqual({
      status: 'too_long',
      durationSecs: 900,
    });
    expect(requests).toHaveLength(0);
  });

  it('retries as MP3 when the provider refuses a native container', async () => {
    const { transcriber, requests, transcoder } = setup([rejected, success]);

    const outcome = await transcriber.transcribe({ url: MP3_URL, messageId: 'msg-4', durationSecs: 10 });

    expect(outcome.status).toBe('ok');
    expect(requests).toHaveLength(2);
    expect(transcoder.calls.toMp3).toHaveLength(1);
    expect((userContent(requests[1])[0].input_audio as { data: string }).data).toBe(TRANSCODED_MP3.toString('base64'));
  });

  it('still tries the original container once when ffmpeg is missing', async () => {
    const { transcriber, requests } = setup([success], { transcoder: createMissingTranscoder() });

    const outcome = await transcriber.transcribe({ url: VOICE_URL, messageId: 'msg-5', durationSecs: 3 });

    expect(outcome.status).toBe('ok');
    expect(userContent(requests[0])[0]).toEqual({
      type: 'input_audio',
      input_audio: { data: OGG_BYTES.toString('base64'), format: 'ogg' },
    });
  });

  it('treats a file without an audio track as silence', async () => {
    const transcoder = createFakeTranscoder({ toMp3: undefined });
    const { transcriber, requests } = setup([success], { transcoder });
    expect(await transcriber.transcribe({ url: VOICE_URL, messageId: 'm' })).toEqual({
      status: 'ok',
      text: '',
      cached: false,
    });
    expect(requests).toHaveLength(0);
  });

  it('fails without caching on an API error, then cools down before retrying', async () => {
    // A 5xx is retried once by the SDK before the call counts as failed.
    const { transcriber, requests, advance } = setup([serverError, serverError, success]);

    expect(await transcriber.transcribe({ url: VOICE_URL, messageId: 'msg-6' })).toEqual({ status: 'failed' });
    expect(requests).toHaveLength(2);
    expect(getStoredTranscript('msg-6')).toBeUndefined();

    expect(await transcriber.transcribe({ url: VOICE_URL, messageId: 'msg-6' })).toEqual({ status: 'failed' });
    expect(requests).toHaveLength(2);

    advance(5 * 60 * 1000 + 1);
    expect((await transcriber.transcribe({ url: VOICE_URL, messageId: 'msg-6' })).status).toBe('ok');
    expect(requests).toHaveLength(3);
  });

  it('never caches an empty completion as silence', async () => {
    const empty: OpenRouterFixture = {
      ...success,
      response: {
        ...(success.response as Record<string, unknown>),
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '' } }],
      },
    };
    const { transcriber } = setup([empty]);
    expect(await transcriber.transcribe({ url: VOICE_URL, messageId: 'msg-7' })).toEqual({ status: 'failed' });
    expect(getStoredTranscript('msg-7')).toBeUndefined();
  });

  it('runs concurrent asks for the same message once', async () => {
    const { transcriber, requests } = setup([success]);
    const [a, b] = await Promise.all([
      transcriber.transcribe({ url: VOICE_URL, messageId: 'msg-8' }),
      transcriber.transcribe({ url: VOICE_URL, messageId: 'msg-8' }),
    ]);
    expect(a).toEqual(b);
    expect(requests).toHaveLength(1);
  });

  it('reports unavailable without an API key', async () => {
    const { transcriber } = setup([], { client: () => undefined });
    expect(await transcriber.transcribe({ url: VOICE_URL, messageId: 'm' })).toEqual({ status: 'unavailable' });
    expect(files.urls).toEqual([]);
  });

  it('reports files over 25 MB as too large', async () => {
    const huge = 'https://cdn.discordapp.com/attachments/1/9/huge.mp3';
    const fetch = createFileFetch({ [huge]: { body: MP3_BYTES, headers: { 'content-length': String(30 * 1024 * 1024) } } });
    const { transcriber, requests } = setup([success], { fetch });
    expect(await transcriber.transcribe({ url: huge, messageId: 'm' })).toEqual({ status: 'too_large' });
    expect(requests).toHaveLength(0);
  });

  it('transcribes in-memory audio (a video track) without caching', async () => {
    const { transcriber, requests } = setup([success]);
    expect(await transcriber.transcribeBuffer(TRANSCODED_MP3, 'mp3', 'clip')).toEqual({
      status: 'ok',
      text: TRANSCRIPT,
      cached: false,
    });
    expect(requests).toHaveLength(1);
  });
});

describe('cleanTranscript', () => {
  it('strips wrappers and labels models add despite instructions', () => {
    expect(cleanTranscript('```\nhello there\n```')).toBe('hello there');
    expect(cleanTranscript('Transcript: hello there')).toBe('hello there');
    expect(cleanTranscript('"hello there"')).toBe('hello there');
  });

  it('keeps inner quotes and the English line', () => {
    expect(cleanTranscript('he said "go" and "stop"')).toBe('he said "go" and "stop"');
    expect(cleanTranscript('hola\nEnglish: hello')).toBe('hola\nEnglish: hello');
  });

  it('maps the no-speech marker to an empty transcript and nothing at all to undefined', () => {
    expect(cleanTranscript('[no speech]')).toBe('');
    expect(cleanTranscript(' [No Speech]. ')).toBe('');
    expect(cleanTranscript('   ')).toBeUndefined();
  });

  it('caps runaway output', () => {
    const long = cleanTranscript('a'.repeat(20_000));
    expect(long?.length).toBe(12_001);
    expect(long?.endsWith('…')).toBe(true);
  });
});
