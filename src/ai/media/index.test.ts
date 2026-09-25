// The stable entry points other features call (link reader, learner, summaries, commands).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import {
  CATALOG_MODELS,
  MP4_BYTES,
  OGG_BYTES,
  createFakeCatalog,
  createFakeTranscoder,
  createFileFetch,
  createFileSafeFetch,
} from '../../test-support/fakeMedia';
import { createCapturingClient, fixtureReply } from '../../test-support/capturingClient';
import { type OpenRouterFixture, loadFixture } from '../../test-support/openRouterFetch';
import {
  getCachedTranscript,
  getVideoDescriber,
  setMediaForTesting,
  startTranscriptionRouteChecks,
  transcribeAudio,
  watchVideo,
} from './index';
import { AudioTranscriber } from './transcriber';
import { VideoDescriber } from './video';

const VOICE_URL = 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg';
const CLIP_URL = 'https://video.twimg.com/ext_tw_video/1/pu/vid/720x1280/clip.mp4';
const TRANSCRIPT = 'salut tout le monde, on se fait une game ce soir?';

function install(fixtures: OpenRouterFixture[] = []) {
  const { client, requests } = createCapturingClient(fixtures.map(fixtureReply));
  const fetch = createFileFetch({ [VOICE_URL]: { body: OGG_BYTES, contentType: 'audio/ogg' } });
  // The clip is on a third-party host: it comes through the SSRF-guarded fetch.
  const safeFetch = createFileSafeFetch({ [CLIP_URL]: { body: MP4_BYTES, contentType: 'video/mp4' } });
  const common = {
    client: () => client,
    fetch,
    safeFetch,
    transcoder: createFakeTranscoder({ probe: { durationSecs: 20, hasAudio: true, hasVideo: true } }),
    catalog: createFakeCatalog(CATALOG_MODELS),
    model: () => 'google/gemini-3.5-flash-lite',
  };
  const transcriber = new AudioTranscriber({ ...common, maxSeconds: () => 600 });
  const describer = new VideoDescriber({ ...common, transcriber, maxBytes: () => 1024 * 1024 });
  setMediaForTesting({ transcriber, describer });
  return { requests };
}

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setMediaForTesting(undefined);
  setBotDbForTesting(undefined);
});

describe('media entry points', () => {
  it('transcribeAudio returns the text and caches it for getCachedTranscript', async () => {
    const { requests } = install([loadFixture('transcription-success')]);
    expect(getCachedTranscript('voice-1')).toBeUndefined();

    expect(await transcribeAudio({ url: VOICE_URL, messageId: 'voice-1', durationSecs: 4 })).toBe(TRANSCRIPT);

    expect(getCachedTranscript('voice-1')).toBe(TRANSCRIPT);
    expect(await transcribeAudio({ url: VOICE_URL, messageId: 'voice-1' })).toBe(TRANSCRIPT);
    expect(requests).toHaveLength(1);
  });

  it('transcribeAudio returns undefined when nothing was transcribed', async () => {
    install();
    expect(await transcribeAudio({ url: VOICE_URL, messageId: 'voice-2', durationSecs: 3600 })).toBeUndefined();
  });

  it('watchVideo returns the description and caches it per URL', async () => {
    install([loadFixture('video-description')]);
    const outcome = await watchVideo({ url: CLIP_URL, contentType: 'video/mp4', context: 'shared by Jasper' });
    expect(outcome).toMatchObject({ status: 'ok', text: expect.stringMatching(/^League of Legends clip/) });
    expect(getVideoDescriber().cached(CLIP_URL)).toBe(outcome.status === 'ok' ? outcome.text : 'no description');
  });

  it('reports nothing without an API key (the defaults under test)', async () => {
    expect(await transcribeAudio({ url: VOICE_URL, messageId: 'voice-3' })).toBeUndefined();
    expect(await watchVideo({ url: CLIP_URL })).toEqual({ status: 'unavailable' });
    expect(getCachedTranscript('voice-3')).toBeUndefined();
  });
});

describe('startTranscriptionRouteChecks', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('checks the route at startup and then daily, once however often it is started', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    const transcriber = new AudioTranscriber({ transcoder: createFakeTranscoder(), catalog: createFakeCatalog() });
    const route = vi.spyOn(transcriber, 'route').mockResolvedValue({ kind: 'stt', model: 'openai/whisper-large-v3' });
    setMediaForTesting({ transcriber });

    const stop = startTranscriptionRouteChecks(1000);
    startTranscriptionRouteChecks(1000);
    expect(route).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(route).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(5000);
    expect(route).toHaveBeenCalledTimes(2);
  });

  it('does nothing without an API key', () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const transcriber = new AudioTranscriber({ transcoder: createFakeTranscoder(), catalog: createFakeCatalog() });
    const route = vi.spyOn(transcriber, 'route');
    setMediaForTesting({ transcriber });
    const stop = startTranscriptionRouteChecks();
    stop();
    expect(route).not.toHaveBeenCalled();
  });
});
