import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import {
  CATALOG_MODELS,
  MKV_BYTES,
  MP4_BYTES,
  TRANSCODED_MP3,
  createFakeCatalog,
  createFakeTranscoder,
  createFileFetch,
  createMissingTranscoder,
  userContent,
} from '../../test-support/fakeMedia';
import { createCapturingClient, fixtureReply } from '../../test-support/capturingClient';
import { type OpenRouterFixture, loadFixture } from '../../test-support/openRouterFetch';
import { FEATURE_HEADER } from '../usage';
import { AudioTranscriber } from './transcriber';
import type { TranscriptionOutcome } from './types';
import { VideoDescriber, type VideoDescriberOptions } from './video';

const CLIP_URL = 'https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=1&hm=sig';
const MKV_URL = 'https://cdn.discordapp.com/attachments/1/3/clip.mkv';
const FRAME = Buffer.from('fake-jpeg');

const described = loadFixture('video-description');
const serverError = loadFixture('http-500-error');
const DESCRIPTION = (described.response as { choices: Array<{ message: { content: string } }> }).choices[0].message
  .content;

function setup(fixtures: OpenRouterFixture[], overrides: Partial<VideoDescriberOptions> = {}) {
  const { client, requests } = createCapturingClient(fixtures.map(fixtureReply));
  const transcribed: Buffer[] = [];
  const fetch = createFileFetch({
    [CLIP_URL]: { body: MP4_BYTES, contentType: 'video/mp4' },
    [MKV_URL]: { body: MKV_BYTES, contentType: 'video/x-matroska' },
  });
  const describer = new VideoDescriber({
    client: () => client,
    fetch,
    transcoder: createFakeTranscoder({ probe: { durationSecs: 30, hasAudio: true, hasVideo: true } }),
    transcriber: {
      transcribeBuffer: async (data): Promise<TranscriptionOutcome> => {
        transcribed.push(data);
        return { status: 'ok', text: 'no way, NO WAY', cached: false };
      },
    },
    model: () => 'google/gemini-3.5-flash-lite',
    maxBytes: () => 1024,
    maxSeconds: () => 300,
    inputMode: () => 'auto',
    maxAudioSeconds: () => 600,
    catalog: createFakeCatalog(CATALOG_MODELS),
    ...overrides,
  });
  return { describer, requests, fetch, transcribed };
}

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setBotDbForTesting(undefined);
});

describe('VideoDescriber', () => {
  it('sends a small clip whole, as a data URL, with ZDR routing and the video tag', async () => {
    const { describer, requests } = setup([described]);

    const outcome = await describer.describe({ url: CLIP_URL, contentType: 'video/mp4', context: 'Posted by Wheelie.' });

    expect(outcome).toEqual({ status: 'ok', text: DESCRIPTION, cached: false });
    const [request] = requests;
    expect(request.body.provider).toEqual({ zdr: true });
    expect(request.headers.get(FEATURE_HEADER)).toBe('video');
    const [video, prompt] = userContent(request);
    expect(video).toEqual({
      type: 'video_url',
      video_url: { url: `data:video/mp4;base64,${MP4_BYTES.toString('base64')}` },
    });
    expect(String(prompt.text)).toContain('Context from the chat: Posted by Wheelie.');
    // Gemini hears the soundtrack itself: no separate transcript, and the catalog's lowest effort.
    expect(String(prompt.text)).not.toContain('not hear it');
    expect(request.body.reasoning).toEqual({ effort: 'minimal' });
  });

  it('gives a model that watches but cannot hear (GLM) the soundtrack transcript', async () => {
    const transcoder = createFakeTranscoder({ probe: { durationSecs: 30, hasAudio: true, hasVideo: true } });
    const { describer, requests, transcribed } = setup([described], { model: () => 'z-ai/glm-5.3-flash', transcoder });

    expect((await describer.describe({ url: CLIP_URL })).status).toBe('ok');

    expect(transcoder.calls.toMp3).toEqual([{ input: MP4_BYTES, maxSeconds: 600 }]);
    expect(transcribed).toEqual([TRANSCODED_MP3]);
    const [video, prompt] = userContent(requests[0]);
    expect(video.type).toBe('video_url');
    expect(String(prompt.text)).toContain(
      'You can see this video but not hear it. Transcript of its audio:\nno way, NO WAY',
    );
    expect(requests[0].body.model).toBe('z-ai/glm-5.3-flash');
    expect(requests[0].body.reasoning).toEqual({ effort: 'low' });
    expect(requests[0].body.provider).toEqual({ zdr: true });
  });

  it('pays for the soundtrack once when the native call fails and keyframes take over', async () => {
    const transcoder = createFakeTranscoder({
      probe: { durationSecs: 30, hasAudio: true, hasVideo: true },
      sampleVideo: { durationSecs: 30, frames: [FRAME], audio: TRANSCODED_MP3 },
    });
    const { describer, requests, transcribed } = setup([serverError, serverError, described], {
      model: () => 'z-ai/glm-5.3-flash',
      transcoder,
    });

    expect((await describer.describe({ url: CLIP_URL })).status).toBe('ok');

    expect(transcribed).toHaveLength(1);
    expect(userContent(requests[2])[0].type).toBe('image_url');
    expect(String(userContent(requests[2]).at(-1)?.text)).toContain('Transcript of its audio:\nno way, NO WAY');
  });

  it('tells a non-hearing model the audio is unavailable when ffmpeg is missing', async () => {
    const { describer, requests } = setup([described], {
      model: () => 'z-ai/glm-5.3-flash',
      transcoder: createMissingTranscoder(),
    });
    expect((await describer.describe({ url: CLIP_URL })).status).toBe('ok');
    expect(String(userContent(requests[0])[1].text)).toContain(
      "You can see this video but not hear it. Its audio couldn't be transcribed.",
    );
  });

  it('says so when the clip has no audio track at all', async () => {
    const transcoder = createFakeTranscoder({ toMp3: undefined });
    const { describer, requests, transcribed } = setup([described], { model: () => 'z-ai/glm-5.3-flash', transcoder });
    await describer.describe({ url: CLIP_URL, durationSecs: 12 });
    expect(transcribed).toHaveLength(0);
    expect(String(userContent(requests[0])[1].text)).toContain('It has no audio track.');
  });

  it('caches per file: a re-signed Discord URL for the same attachment is free', async () => {
    const { describer, requests } = setup([described]);
    await describer.describe({ url: CLIP_URL });

    const again = await describer.describe({
      url: 'https://media.discordapp.net/attachments/1/2/clip.mp4?ex=2&hm=other',
    });

    expect(again).toEqual({ status: 'ok', text: DESCRIPTION, cached: true });
    expect(requests).toHaveLength(1);
    expect(describer.cached(CLIP_URL)).toBe(DESCRIPTION);
  });

  it('samples keyframes plus the transcript when the clip is over VIDEO_MAX_BYTES', async () => {
    const transcoder = createFakeTranscoder({
      sampleVideo: { durationSecs: 75, frames: [FRAME, FRAME], audio: TRANSCODED_MP3 },
    });
    const { describer, requests, transcribed } = setup([described], { transcoder, maxBytes: () => 16 });

    const outcome = await describer.describe({ url: CLIP_URL });

    expect(outcome.status).toBe('ok');
    expect(transcoder.calls.sampleVideo).toHaveLength(1);
    expect(transcribed).toEqual([TRANSCODED_MP3]);
    const content = userContent(requests[0]);
    expect(content.filter((p) => p.type === 'image_url')).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${FRAME.toString('base64')}` } });
    const text = String(content.at(-1)?.text);
    expect(text).toContain('2 still frames sampled evenly, in order, from a 1:15 video');
    expect(text).toContain('Transcript of its audio:\nno way, NO WAY');
    expect(requests[0].headers.get(FEATURE_HEADER)).toBe('video');
  });

  it('samples keyframes for clips over VIDEO_MAX_SECONDS', async () => {
    const transcoder = createFakeTranscoder({
      probe: { durationSecs: 900, hasAudio: false, hasVideo: true },
      sampleVideo: { durationSecs: 900, frames: [FRAME] },
    });
    const { describer, requests } = setup([described], { transcoder });

    await describer.describe({ url: CLIP_URL });

    expect(userContent(requests[0])[0].type).toBe('image_url');
    expect(String(userContent(requests[0]).at(-1)?.text)).toContain('It has no audio track.');
  });

  it('skims a long linked video from its known duration, without probing it first', async () => {
    const transcoder = createFakeTranscoder({
      probe: { durationSecs: 30, hasAudio: true, hasVideo: true },
      sampleVideo: { durationSecs: 1200, frames: [FRAME, FRAME], audio: TRANSCODED_MP3 },
    });
    const { describer, requests, transcribed } = setup([described], { transcoder, maxBytes: () => 1024 * 1024 });

    const outcome = await describer.describe({ url: CLIP_URL, contentType: 'video/mp4', durationSecs: 1200 });

    expect(outcome.status).toBe('ok');
    expect(transcoder.calls.probe).toEqual([]);
    expect(transcoder.calls.sampleVideo).toHaveLength(1);
    expect(transcribed).toEqual([TRANSCODED_MP3]);
    const text = String(userContent(requests[0]).at(-1)?.text);
    expect(userContent(requests[0])[0].type).toBe('image_url');
    expect(text).toContain('2 still frames sampled evenly, in order, from a 20:00 video');
    expect(text).toContain("Transcript of the first 10:00 of its audio (the rest wasn't transcribed):\nno way, NO WAY");
  });

  it('samples keyframes for containers the video endpoint does not take', async () => {
    const transcoder = createFakeTranscoder({ sampleVideo: { frames: [FRAME] } });
    const { describer, requests } = setup([described], { transcoder });
    expect((await describer.describe({ url: MKV_URL, contentType: 'video/x-matroska' })).status).toBe('ok');
    expect(userContent(requests[0])[0].type).toBe('image_url');
  });

  it('samples keyframes for non-video models in auto mode, and always in frames mode', async () => {
    const qwen = setup([described], {
      model: () => 'qwen/qwen3-vl-235b-a22b-instruct',
      transcoder: createFakeTranscoder({ sampleVideo: { frames: [FRAME] } }),
    });
    await qwen.describer.describe({ url: CLIP_URL });
    expect(userContent(qwen.requests[0])[0].type).toBe('image_url');

    setBotDbForTesting(new BotDb(':memory:'));
    const forced = setup([described], {
      inputMode: () => 'frames',
      transcoder: createFakeTranscoder({ sampleVideo: { frames: [FRAME] } }),
    });
    await forced.describer.describe({ url: CLIP_URL });
    expect(userContent(forced.requests[0])[0].type).toBe('image_url');
  });

  it('falls back to keyframes when the native call fails', async () => {
    const transcoder = createFakeTranscoder({
      probe: { durationSecs: 10, hasAudio: true, hasVideo: true },
      sampleVideo: { frames: [FRAME] },
    });
    const { describer, requests } = setup([serverError, serverError, described], { transcoder });

    expect((await describer.describe({ url: CLIP_URL })).status).toBe('ok');
    expect(userContent(requests[0])[0].type).toBe('video_url');
    expect(userContent(requests[2])[0].type).toBe('image_url');
  });

  it('still describes natively when ffmpeg is missing (the probe is optional)', async () => {
    const { describer, requests } = setup([described], { transcoder: createMissingTranscoder() });
    expect((await describer.describe({ url: CLIP_URL })).status).toBe('ok');
    expect(userContent(requests[0])[0].type).toBe('video_url');
  });

  it('fails without caching when neither path works', async () => {
    const { describer, requests } = setup([serverError, serverError], {
      transcoder: createMissingTranscoder(),
    });
    expect(await describer.describe({ url: CLIP_URL })).toEqual({ status: 'failed' });
    expect(describer.cached(CLIP_URL)).toBeUndefined();
    // Cooling down: no second attempt right away.
    expect(await describer.describe({ url: CLIP_URL })).toEqual({ status: 'failed' });
    expect(requests).toHaveLength(2);
  });

  it('reports too-large files without calling a model', async () => {
    const big = 'https://cdn.discordapp.com/attachments/1/4/huge.mp4';
    const fetch = createFileFetch({ [big]: { body: MP4_BYTES, headers: { 'content-length': String(80 * 1024 * 1024) } } });
    const { describer, requests } = setup([described], { fetch });
    expect(await describer.describe({ url: big })).toEqual({ status: 'too_large' });
    expect(requests).toHaveLength(0);
  });

  it('reports unavailable without an API key', async () => {
    const { describer, fetch } = setup([], { client: () => undefined });
    expect(await describer.describe({ url: CLIP_URL })).toEqual({ status: 'unavailable' });
    expect(fetch.urls).toEqual([]);
  });

  it('runs concurrent asks for the same clip once', async () => {
    const { describer, requests } = setup([described]);
    await Promise.all([describer.describe({ url: CLIP_URL }), describer.describe({ url: CLIP_URL })]);
    expect(requests).toHaveLength(1);
  });
});

describe('VideoDescriber: soundtrack through the real transcriber', () => {
  const transcribedFixture = loadFixture('transcription-success');

  it('transcribes the soundtrack of a skimmed long video, though the cut MP3 probes a hair over the cap', async () => {
    // ffmpeg's `-t 600` MP3 cut probes as 600.084 s (encoder padding): measured with the real transcoder.
    const transcoder = createFakeTranscoder({
      probe: { durationSecs: 600.084, hasAudio: true, hasVideo: false },
      sampleVideo: { durationSecs: 720, frames: [FRAME], audio: TRANSCODED_MP3 },
    });
    const { client, requests } = createCapturingClient([transcribedFixture, described].map(fixtureReply));
    const transcriber = new AudioTranscriber({
      client: () => client,
      transcoder,
      model: () => 'google/gemini-3.5-flash-lite',
      maxSeconds: () => 600,
      catalog: createFakeCatalog(CATALOG_MODELS),
    });
    const describer = new VideoDescriber({
      client: () => client,
      fetch: createFileFetch({ [CLIP_URL]: { body: MP4_BYTES, contentType: 'video/mp4' } }),
      transcoder,
      transcriber,
      model: () => 'google/gemini-3.5-flash-lite',
      maxBytes: () => 1024,
      maxSeconds: () => 300,
      inputMode: () => 'auto',
      maxAudioSeconds: () => 600,
      catalog: createFakeCatalog(CATALOG_MODELS),
    });

    expect((await describer.describe({ url: CLIP_URL, durationSecs: 720 })).status).toBe('ok');

    expect(requests).toHaveLength(2);
    expect(userContent(requests[0])[0].type).toBe('input_audio');
    const text = String(userContent(requests[1]).at(-1)?.text);
    expect(text).toContain("Transcript of the first 10:00 of its audio (the rest wasn't transcribed):");
    expect(text).not.toContain("couldn't be transcribed");
  });

  it('also transcribes it when the video reports no length of its own', async () => {
    const transcoder = createFakeTranscoder({
      probe: { durationSecs: 600.084, hasAudio: true, hasVideo: false },
      sampleVideo: { frames: [FRAME], audio: TRANSCODED_MP3 },
    });
    const { client, requests } = createCapturingClient([transcribedFixture, described].map(fixtureReply));
    const transcriber = new AudioTranscriber({
      client: () => client,
      transcoder,
      model: () => 'google/gemini-3.5-flash-lite',
      maxSeconds: () => 600,
      catalog: createFakeCatalog(CATALOG_MODELS),
    });
    const { describer } = setup([], { client: () => client, transcoder, transcriber, inputMode: () => 'frames' });

    expect((await describer.describe({ url: CLIP_URL })).status).toBe('ok');

    expect(requests).toHaveLength(2);
    expect(String(userContent(requests[1]).at(-1)?.text)).toContain('Transcript of its audio:');
  });
});

describe('VideoDescriber: follow-up questions', () => {
  const answered = loadFixture('video-answer');
  const ANSWER = 'At 0:27 he yells "no way, NO WAY" as the triple kill banner appears, then laughs.';

  it('answers a question by watching again, reusing the clip it just downloaded', async () => {
    const { describer, requests, fetch } = setup([described, answered]);
    await describer.describe({ url: CLIP_URL, contentType: 'video/mp4' });

    const outcome = await describer.ask({ url: CLIP_URL, question: 'what does he yell at the end?' });

    expect(outcome).toEqual({ status: 'ok', text: ANSWER, cached: false });
    expect(fetch.urls).toHaveLength(1);
    const [video, prompt] = userContent(requests[1]);
    expect(video.type).toBe('video_url');
    expect(String(prompt.text)).toContain('Answer this question about the video: "what does he yell at the end?"');
    expect(String(prompt.text)).toContain("If it doesn't show or say that, say so plainly");
    expect(String(prompt.text)).not.toContain('On-screen text:');
    expect(requests[1].body.provider).toEqual({ zdr: true });
    expect(requests[1].headers.get(FEATURE_HEADER)).toBe('video');
  });

  it('caches answers per clip and question (case and punctuation aside), apart from the description', async () => {
    const { describer, requests } = setup([answered]);
    await describer.ask({ url: CLIP_URL, question: 'What does he yell at the end?' });

    expect(await describer.ask({ url: CLIP_URL, question: 'what does he yell at the end' })).toEqual({
      status: 'ok',
      text: ANSWER,
      cached: true,
    });
    expect(requests).toHaveLength(1);
    expect(describer.cached(CLIP_URL)).toBeUndefined();
  });

  it('routes describe() with a question to ask()', async () => {
    const { describer, requests } = setup([answered]);
    expect((await describer.describe({ url: CLIP_URL, question: 'who scores?' })).status).toBe('ok');
    expect(String(userContent(requests[0])[1].text)).toContain('"who scores?"');
  });

  it('downloads again once the clip has left the short-lived cache', async () => {
    let now = 1_000_000;
    const { describer, fetch } = setup([described, answered], { now: () => now });
    await describer.describe({ url: CLIP_URL });
    now += 11 * 60 * 1000;
    await describer.ask({ url: CLIP_URL, question: 'who scores?' });
    expect(fetch.urls).toHaveLength(2);
  });

  it('asks about long clips from keyframes and the soundtrack transcript', async () => {
    const transcoder = createFakeTranscoder({
      probe: { durationSecs: 900, hasAudio: true, hasVideo: true },
      sampleVideo: { durationSecs: 900, frames: [FRAME], audio: TRANSCODED_MP3 },
    });
    const { describer, requests } = setup([answered], { transcoder });
    await describer.ask({ url: CLIP_URL, question: 'who scores?' });
    const text = String(userContent(requests[0]).at(-1)?.text);
    expect(userContent(requests[0])[0].type).toBe('image_url');
    // The soundtrack is cut at VOICE_MAX_SECONDS (600 here): the model is told how much it heard.
    expect(text).toContain("Transcript of the first 10:00 of its audio (the rest wasn't transcribed):\nno way, NO WAY");
    expect(text).toContain('Answer this question about the video: "who scores?"');
  });
});

describe('VideoDescriber: daily budget', () => {
  const overBudget = { check: () => ({ ok: false as const, spentUsd: 0.5012, budgetUsd: 0.5 }) };

  it('neither downloads nor calls a model once the day’s budget is spent', async () => {
    const { describer, requests, fetch } = setup([described], { budget: overBudget });
    expect(await describer.describe({ url: CLIP_URL })).toEqual({ status: 'over_budget' });
    expect(await describer.ask({ url: CLIP_URL, question: 'who scores?' })).toEqual({ status: 'over_budget' });
    expect(fetch.urls).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('still serves what is already cached', async () => {
    let spent = false;
    const budget = { check: () => (spent ? overBudget.check() : { ok: true as const }) };
    const { describer } = setup([described], { budget });
    await describer.describe({ url: CLIP_URL });
    spent = true;
    expect(await describer.describe({ url: CLIP_URL })).toEqual({ status: 'ok', text: DESCRIPTION, cached: true });
  });

  it('stops before the keyframe call when the native attempt used up the budget, without cooling down', async () => {
    let checks = 0;
    const budget = { check: () => (++checks > 1 ? overBudget.check() : { ok: true as const }) };
    const transcoder = createFakeTranscoder({
      probe: { durationSecs: 10, hasAudio: true, hasVideo: true },
      sampleVideo: { frames: [FRAME] },
    });
    const { describer, requests } = setup([serverError, serverError, described], { budget, transcoder });

    expect(await describer.describe({ url: CLIP_URL })).toEqual({ status: 'over_budget' });
    expect(requests).toHaveLength(2);

    // Not a failure: tomorrow (here, a budget with room again) it is watched right away.
    checks = -10;
    expect((await describer.describe({ url: CLIP_URL })).status).toBe('ok');
    expect(requests).toHaveLength(3);
  });
});
