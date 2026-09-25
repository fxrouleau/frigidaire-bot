import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import {
  MKV_BYTES,
  MP4_BYTES,
  TRANSCODED_MP3,
  createCapturingClient,
  createFakeTranscoder,
  createFileFetch,
  createMissingTranscoder,
  userContent,
} from '../../test-support/fakeMedia';
import { type OpenRouterFixture, loadFixture } from '../../test-support/openRouterFetch';
import { FEATURE_HEADER } from '../usage';
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
  const { client, requests } = createCapturingClient(fixtures);
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

    const outcome = await describer.describe({ url: CLIP_URL, contentType: 'video/mp4', context: 'Posted by Wheezer.' });

    expect(outcome).toEqual({ status: 'ok', text: DESCRIPTION, cached: false });
    const [request] = requests;
    expect(request.body.provider).toEqual({ zdr: true });
    expect(request.headers[FEATURE_HEADER.toLowerCase()]).toBe('video');
    const [video, prompt] = userContent(request);
    expect(video).toEqual({
      type: 'video_url',
      video_url: { url: `data:video/mp4;base64,${MP4_BYTES.toString('base64')}` },
    });
    expect(String(prompt.text)).toContain('Context from the chat: Posted by Wheezer.');
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
    expect(requests[0].headers[FEATURE_HEADER.toLowerCase()]).toBe('video');
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
