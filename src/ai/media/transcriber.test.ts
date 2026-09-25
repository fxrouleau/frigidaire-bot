import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logger';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import {
  CATALOG_MODELS,
  type FakeEndpoints,
  MP3_BYTES,
  OGG_BYTES,
  TRANSCODED_MP3,
  createCapturingClient,
  createFakeCatalog,
  createFakeTranscoder,
  createFileFetch,
  type FakeTranscoder,
  createMissingTranscoder,
  userContent,
  WHISPER_ENDPOINTS,
} from '../../test-support/fakeMedia';
import { type OpenRouterFixture, loadFixture } from '../../test-support/openRouterFetch';
import { FEATURE_HEADER } from '../usage';
import { getStoredTranscript } from './store';
import {
  AudioTranscriber,
  type AudioTranscriberOptions,
  INLINE_AUDIO_MAX_BYTES,
  cleanTranscript,
  looksLikeSttModel,
} from './transcriber';

const VOICE_URL = 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg?ex=1&hm=sig';
const MP3_URL = 'https://cdn.discordapp.com/attachments/1/3/memo.mp3';
const MODEL = 'google/gemini-3.5-flash-lite';
// An audio model outside the Gemini family: only wav/mp3 go as-is, so a voice message is transcoded.
const BASELINE_MODEL = 'openai/gpt-audio-mini';

const success = loadFixture('transcription-success');
const noSpeech = loadFixture('transcription-no-speech');
const rejected = loadFixture('audio-format-rejected');
const serverError = loadFixture('http-500-error');
const TRANSCRIPT = 'salut tout le monde, on se fait une game ce soir?';

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
    catalog: createFakeCatalog(CATALOG_MODELS),
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
  it('sends a Discord voice message to Gemini as-is, with ZDR routing and the transcription tag', async () => {
    const { transcriber, requests, transcoder } = setup([success]);

    const outcome = await transcriber.transcribe({
      url: VOICE_URL,
      contentType: 'audio/ogg',
      messageId: 'msg-1',
      durationSecs: 4.2,
    });

    expect(outcome).toEqual({ status: 'ok', text: TRANSCRIPT, cached: false });
    // Vertex documents audio/ogg for Gemini 3.5 Flash-Lite: no ffmpeg round trip.
    expect(transcoder.calls.toMp3).toEqual([]);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(request.body.model).toBe(MODEL);
    expect(request.body.provider).toEqual({ zdr: true });
    expect(request.body.temperature).toBeUndefined();
    // Flash-Lite's lowest effort, from the catalog: a verbatim transcript needs no thinking.
    expect(request.body.reasoning).toEqual({ effort: 'minimal' });
    expect(request.headers[FEATURE_HEADER.toLowerCase()]).toBe('transcription');
    const [audio, prompt] = userContent(request);
    expect(audio).toEqual({
      type: 'input_audio',
      input_audio: { data: OGG_BYTES.toString('base64'), format: 'ogg' },
    });
    expect(prompt.type).toBe('text');
    // Same output as the speech-to-text route: the words as spoken, no translation line.
    expect(String(prompt.text)).not.toMatch(/English/);
  });

  it('transcodes a voice message to MP3 for models that only take wav/mp3', async () => {
    const { transcriber, requests, transcoder } = setup([success], { model: () => BASELINE_MODEL });

    await transcriber.transcribe({ url: VOICE_URL, contentType: 'audio/ogg', messageId: 'msg-1', durationSecs: 4 });

    expect(transcoder.calls.toMp3).toEqual([{ input: OGG_BYTES, maxSeconds: 600 }]);
    expect(userContent(requests[0])[0]).toEqual({
      type: 'input_audio',
      input_audio: { data: TRANSCODED_MP3.toString('base64'), format: 'mp3' },
    });
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

  it('exposes a run in flight, so a history reader can join it for free', async () => {
    const { transcriber, requests } = setup([success]);
    expect(transcriber.pending('msg-9')).toBeUndefined();

    const run = transcriber.transcribe({ url: VOICE_URL, messageId: 'msg-9', durationSecs: 4 });
    const joined = transcriber.pending('msg-9');

    expect(joined).toBeDefined();
    expect(await joined).toEqual({ status: 'ok', text: TRANSCRIPT, cached: false });
    expect(await run).toEqual({ status: 'ok', text: TRANSCRIPT, cached: false });
    expect(requests).toHaveLength(1);
    expect(transcriber.pending('msg-9')).toBeUndefined();
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

  it('gives a probed length the MP3 padding slack: a track cut at the cap is not too long', async () => {
    // ffmpeg's `-t 600` MP3 cut probes as 600.084 s.
    const transcoder = createFakeTranscoder({ probe: { durationSecs: 600.084, hasAudio: true, hasVideo: false } });
    const { transcriber, requests } = setup([success], { transcoder });
    expect((await transcriber.transcribeBuffer(TRANSCODED_MP3, 'mp3', 'clip')).status).toBe('ok');
    expect(requests).toHaveLength(1);
  });

  it('takes a caller-known buffer length instead of probing it', async () => {
    const transcoder = createFakeTranscoder({ probe: { durationSecs: 1200, hasAudio: true, hasVideo: false } });
    const { transcriber, requests } = setup([success], { transcoder });
    expect((await transcriber.transcribeBuffer(TRANSCODED_MP3, 'mp3', 'clip', { durationSecs: 600 })).status).toBe('ok');
    expect(transcoder.calls.probe).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('uses the source length the transcoder reports for transcoded files', async () => {
    const transcoder = createFakeTranscoder({ toMp3: { data: TRANSCODED_MP3, durationSecs: 900 } });
    const { transcriber, requests } = setup([success], { transcoder, model: () => BASELINE_MODEL });
    expect(await transcriber.transcribe({ url: VOICE_URL, messageId: 'm' })).toEqual({
      status: 'too_long',
      durationSecs: 900,
    });
    expect(requests).toHaveLength(0);
  });

  it('retries as MP3 when the provider refuses a native container', async () => {
    const { transcriber, requests, transcoder } = setup([rejected, success]);

    const outcome = await transcriber.transcribe({ url: VOICE_URL, messageId: 'msg-4', durationSecs: 10 });

    expect(outcome.status).toBe('ok');
    expect(requests).toHaveLength(2);
    expect((userContent(requests[0])[0].input_audio as { format: string }).format).toBe('ogg');
    expect(transcoder.calls.toMp3).toHaveLength(1);
    expect((userContent(requests[1])[0].input_audio as { data: string }).data).toBe(TRANSCODED_MP3.toString('base64'));
  });

  it('still tries the original container once when ffmpeg is missing', async () => {
    const { transcriber, requests } = setup([success], {
      transcoder: createMissingTranscoder(),
      model: () => BASELINE_MODEL,
    });

    const outcome = await transcriber.transcribe({ url: VOICE_URL, messageId: 'msg-5', durationSecs: 3 });

    expect(outcome.status).toBe('ok');
    expect(userContent(requests[0])[0]).toEqual({
      type: 'input_audio',
      input_audio: { data: OGG_BYTES.toString('base64'), format: 'ogg' },
    });
  });

  it('treats a file without an audio track as silence', async () => {
    const transcoder = createFakeTranscoder({ toMp3: undefined });
    const { transcriber, requests } = setup([success], { transcoder, model: () => BASELINE_MODEL });
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

  it('sends no reasoning override when the catalog has none for the model', async () => {
    const { transcriber, requests } = setup([success], { model: () => BASELINE_MODEL });
    await transcriber.transcribe({ url: MP3_URL, messageId: 'm', durationSecs: 5 });
    expect(requests[0].body.reasoning).toBeUndefined();
  });

  it('turns itself off, before downloading, when TRANSCRIPTION_MODEL cannot hear', async () => {
    const { transcriber, requests } = setup([success], { model: () => 'z-ai/glm-5.3-flash' });
    expect(await transcriber.transcribe({ url: VOICE_URL, messageId: 'm' })).toEqual({ status: 'unavailable' });
    expect(await transcriber.transcribeBuffer(TRANSCODED_MP3, 'mp3', 'clip')).toEqual({ status: 'unavailable' });
    expect(files.urls).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('still tries a model the catalog does not know', async () => {
    const { transcriber, requests } = setup([success], { model: () => 'acme/brand-new-audio-model' });
    expect((await transcriber.transcribe({ url: MP3_URL, messageId: 'm', durationSecs: 5 })).status).toBe('ok');
    expect(requests).toHaveLength(1);
  });

  it('re-encodes native-format files too big to send inline', async () => {
    const bigUrl = 'https://cdn.discordapp.com/attachments/1/7/long.wav';
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WAVE'),
      Buffer.alloc(INLINE_AUDIO_MAX_BYTES),
    ]);
    const fetch = createFileFetch({ [bigUrl]: { body: wav, contentType: 'audio/wav' } });
    const { transcriber, requests, transcoder } = setup([success], { fetch });

    expect((await transcriber.transcribe({ url: bigUrl, messageId: 'm', durationSecs: 500 })).status).toBe('ok');

    expect(transcoder.calls.toMp3).toHaveLength(1);
    expect((userContent(requests[0])[0].input_audio as { format: string }).format).toBe('mp3');
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

describe('AudioTranscriber: Whisper route', () => {
  const WHISPER = 'openai/whisper-large-v3';
  const FALLBACK = 'google/gemini-3.5-flash-lite';
  const whisperVerbose = loadFixture('stt-whisper-verbose');
  const whisperSilence = loadFixture('stt-whisper-silence');
  const whisperPlain = loadFixture('stt-whisper-plain');
  const SAID = "Salut tout le monde, on se fait une game ce soir ? Genre vers 21 h, j'amène les chips.";

  function whisperSetup(
    fixtures: OpenRouterFixture[],
    endpoints: Parameters<typeof createFakeCatalog>[1] = { [WHISPER]: WHISPER_ENDPOINTS },
    overrides: SetupOverrides = {},
  ) {
    return setup(fixtures, {
      model: () => WHISPER,
      fallbackModel: () => FALLBACK,
      catalog: createFakeCatalog(CATALOG_MODELS, endpoints),
      ...overrides,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a voice message's Ogg as-is to the speech-to-text endpoint, and keeps only what was said", async () => {
    const { transcriber, requests, transcoder } = whisperSetup([whisperVerbose]);

    const outcome = await transcriber.transcribe({ url: VOICE_URL, contentType: 'audio/ogg', messageId: 'v1', durationSecs: 9.4 });

    expect(outcome).toEqual({ status: 'ok', text: SAID, cached: false });
    expect(transcoder.calls.toMp3).toEqual([]);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(request.body).toEqual({
      model: WHISPER,
      input_audio: { data: OGG_BYTES.toString('base64'), format: 'ogg' },
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });
    expect(request.headers[FEATURE_HEADER.toLowerCase()]).toBe('transcription');
    // No translation line on either route.
    expect(outcome.status === 'ok' && outcome.text.includes('English:')).toBe(false);
    expect(getStoredTranscript('v1')).toBe(SAID);
  });

  it("stores Whisper's silence hallucination as no speech", async () => {
    const { transcriber } = whisperSetup([whisperSilence]);
    expect(await transcriber.transcribe({ url: VOICE_URL, messageId: 'v2', durationSecs: 4.1 })).toEqual({
      status: 'ok',
      text: '',
      cached: false,
    });
    expect(getStoredTranscript('v2')).toBe('');
  });

  it('skips clips under a second without downloading or calling anything', async () => {
    const { transcriber, requests } = whisperSetup([whisperVerbose]);
    expect(await transcriber.transcribe({ url: VOICE_URL, messageId: 'v3', durationSecs: 0.6 })).toEqual({
      status: 'ok',
      text: '',
      cached: false,
    });
    expect(files.urls).toEqual([]);
    expect(requests).toHaveLength(0);
    expect(getStoredTranscript('v3')).toBe('');
  });

  it('skips files whose probed length is under a second', async () => {
    const transcoder = createFakeTranscoder({ probe: { durationSecs: 0.4, hasAudio: true, hasVideo: false } });
    const { transcriber, requests } = whisperSetup([whisperVerbose], undefined, { transcoder });
    expect((await transcriber.transcribe({ url: MP3_URL, messageId: 'v4' })).status).toBe('ok');
    expect(requests).toHaveLength(0);
  });

  it('retries a refused container as MP3 with the plain json form', async () => {
    const { transcriber, requests, transcoder } = whisperSetup([rejected, whisperPlain]);

    const outcome = await transcriber.transcribe({ url: VOICE_URL, messageId: 'v5', durationSecs: 3.4 });

    expect(outcome).toEqual({ status: 'ok', text: 'Salut tout le monde, on se fait une game ce soir ?', cached: false });
    expect(transcoder.calls.toMp3).toHaveLength(1);
    expect(requests[1].body).toEqual({
      model: WHISPER,
      input_audio: { data: TRANSCODED_MP3.toString('base64'), format: 'mp3' },
    });
  });

  it('transcodes formats the STT hosts do not all take', async () => {
    const aacUrl = 'https://cdn.discordapp.com/attachments/1/4/memo.aac';
    const aac = Buffer.concat([Buffer.from([0xff, 0xf1]), Buffer.alloc(40, 5)]);
    const fetch = createFileFetch({ [aacUrl]: { body: aac, contentType: 'audio/aac' } });
    const { transcriber, requests, transcoder } = whisperSetup([whisperVerbose], undefined, { fetch });

    await transcriber.transcribe({ url: aacUrl, messageId: 'v6', durationSecs: 5 });

    expect(transcoder.calls.toMp3).toHaveLength(1);
    expect((requests[0].body.input_audio as { format: string }).format).toBe('mp3');
    // A first attempt, so the segment scores are still asked for.
    expect(requests[0].body.response_format).toBe('verbose_json');
  });

  it("transcribes a video's soundtrack with Whisper too", async () => {
    const { transcriber, requests } = whisperSetup([whisperVerbose]);
    expect(await transcriber.transcribeBuffer(TRANSCODED_MP3, 'mp3', 'clip')).toEqual({
      status: 'ok',
      text: SAID,
      cached: false,
    });
    expect(requests[0].url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
  });

  it('falls back to the chat model, with a single WARN, when a host is not zero-data-retention', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const leaky = { transcription: true, hosts: [...WHISPER_ENDPOINTS.hosts, { provider: 'Leaky', zdr: false }] };
    const { transcriber, requests } = whisperSetup([success, success], { [WHISPER]: leaky });

    await transcriber.transcribe({ url: VOICE_URL, messageId: 'v7', durationSecs: 4 });
    await transcriber.transcribe({ url: VOICE_URL, messageId: 'v8', durationSecs: 4 });

    expect(requests.map((r) => r.url)).toEqual([
      'https://openrouter.ai/api/v1/chat/completions',
      'https://openrouter.ai/api/v1/chat/completions',
    ]);
    expect(requests[0].body.model).toBe(FALLBACK);
    expect(requests[0].body.provider).toEqual({ zdr: true });
    const routeWarnings = warn.mock.calls.filter((call) => String(call[0]).includes(`not using ${WHISPER}`));
    expect(routeWarnings).toHaveLength(1);
    expect(String(routeWarnings[0][0])).toContain('Leaky');
    expect(getStoredTranscript('v7')).toBe(TRANSCRIPT);
  });

  it("falls back when the hosts can't be checked, or OpenRouter doesn't list the model", async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const unverifiable = whisperSetup([success], {});
    expect(await unverifiable.transcriber.route()).toEqual({ kind: 'chat', model: FALLBACK, effort: 'minimal' });

    const unknown = whisperSetup([success], { [WHISPER]: 'not_found' });
    expect(await unknown.transcriber.route()).toEqual({ kind: 'chat', model: FALLBACK, effort: 'minimal' });
  });

  it('logs the route once, then again only when the verdict changes', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const endpoints: Record<string, FakeEndpoints> = { [WHISPER]: WHISPER_ENDPOINTS };
    const { transcriber } = whisperSetup([], endpoints);

    expect(await transcriber.route()).toEqual({ kind: 'stt', model: WHISPER });
    expect(await transcriber.route()).toEqual({ kind: 'stt', model: WHISPER });
    expect(info.mock.calls.filter((c) => String(c[0]).includes('every endpoint is zero-data-retention'))).toHaveLength(1);

    endpoints[WHISPER] = { transcription: true, hosts: [{ provider: 'Leaky', zdr: false }] };
    expect((await transcriber.route()).kind).toBe('chat');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('uses a chat model named in TRANSCRIPTION_MODEL directly', async () => {
    const { transcriber } = whisperSetup([], {}, { model: () => FALLBACK });
    expect(await transcriber.route()).toEqual({ kind: 'chat', model: FALLBACK, effort: 'minimal' });
  });
});

describe('looksLikeSttModel', () => {
  it('recognizes speech-to-text model names, and nothing else', () => {
    expect(looksLikeSttModel('openai/whisper-large-v3')).toBe(true);
    expect(looksLikeSttModel('openai/gpt-4o-mini-transcribe')).toBe(true);
    expect(looksLikeSttModel('qwen/qwen3-asr-1.7b')).toBe(true);
    expect(looksLikeSttModel('google/gemini-3.5-flash-lite')).toBe(false);
    expect(looksLikeSttModel('z-ai/glm-5.3-flash')).toBe(false);
  });
});

describe('cleanTranscript', () => {
  it('strips wrappers and labels models add despite instructions', () => {
    expect(cleanTranscript('```\nhello there\n```')).toBe('hello there');
    expect(cleanTranscript('Transcript: hello there')).toBe('hello there');
    expect(cleanTranscript('"hello there"')).toBe('hello there');
  });

  it('keeps inner quotes and speaker lines', () => {
    expect(cleanTranscript('he said "go" and "stop"')).toBe('he said "go" and "stop"');
    expect(cleanTranscript('- hola\n- salut')).toBe('- hola\n- salut');
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
