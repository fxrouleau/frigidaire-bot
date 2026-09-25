// Live, paid, opt-in checks of the media pipeline against the real OpenRouter API: SKIPPED unless both
// RUN_LIVE=1 and OPENROUTER_API_KEY are set, so they never run in CI or normal local runs.
//
//   docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... test yarn test:live
//
// What they establish (a fraction of a cent per run; grep the output for MEDIA_LIVE):
//   - the transcription model accepts our audio parts on a zero-data-retention endpoint, for a WAV built
//     in memory and for Discord's own Ogg/Opus container, and reports a tone as "no speech";
//   - the video model describes a clip sent as a base64 data URL on a ZDR endpoint;
//   - which candidate video models (LIVE_VIDEO_MODELS, csv) have a ZDR endpoint that takes base64 video
//     — reported, not asserted, since that is a routing fact about OpenRouter's providers, not our code;
//   - OpenRouter's model catalog still carries the fields modelCatalog.ts reads.
// The media samples are synthetic (a test pattern and sine tones) and committed under
// src/test-support/fixtures/media, so no ffmpeg is needed to run this.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import { createFakeTranscoder, createFileFetch, createMissingTranscoder } from '../../test-support/fakeMedia';
import { getOpenRouterClient } from '../openRouterClient';
import { ModelCatalog } from './modelCatalog';
import { completeMedia, describeError } from './modelCall';
import { AudioTranscriber } from './transcriber';
import { VideoDescriber } from './video';

const RUN_LIVE = process.env.RUN_LIVE === '1' && !!process.env.OPENROUTER_API_KEY;
const LIVE_TIMEOUT = 120_000;
const MEDIA_DIR = path.join(__dirname, '..', '..', 'test-support', 'fixtures', 'media');
const VIDEO_CANDIDATES = (process.env.LIVE_VIDEO_MODELS ?? 'google/gemini-3.5-flash-lite,z-ai/glm-5.3-flash')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

/** 1.5 s of a 440 Hz tone as 16 kHz mono 16-bit PCM WAV. */
function toneWav(): Buffer {
  const rate = 16_000;
  const samples = Math.round(rate * 1.5);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const WAV_URL = 'https://cdn.discordapp.com/attachments/0/0/tone.wav';
const OGG_URL = 'https://cdn.discordapp.com/attachments/0/0/voice-message.ogg';
const MP4_URL = 'https://cdn.discordapp.com/attachments/0/0/test-pattern.mp4';
const files = createFileFetch({
  [WAV_URL]: { body: toneWav(), contentType: 'audio/wav' },
  [OGG_URL]: { body: fs.readFileSync(path.join(MEDIA_DIR, 'tone.ogg')), contentType: 'audio/ogg' },
  [MP4_URL]: { body: fs.readFileSync(path.join(MEDIA_DIR, 'test-pattern.mp4')), contentType: 'video/mp4' },
});

describe.skipIf(!RUN_LIVE)('media pipeline live checks (paid, opt-in)', () => {
  const catalog = new ModelCatalog({ client: getOpenRouterClient });

  it(
    'finds the configured models in the catalog with the modalities they need',
    async () => {
      const transcription = await catalog.catalogInfo(config.media.transcriptionModel);
      const video = await catalog.catalogInfo(config.media.videoModel);
      console.log(
        `MEDIA_LIVE catalog transcription=${config.media.transcriptionModel} modalities=${[...(transcription?.inputModalities ?? [])]} effort=${transcription?.lowestEffort} video=${config.media.videoModel} modalities=${[...(video?.inputModalities ?? [])]} effort=${video?.lowestEffort}`,
      );
      expect(transcription?.inputModalities.has('audio')).toBe(true);
      expect(video?.inputModalities.has('video') || video?.inputModalities.has('image')).toBe(true);
    },
    LIVE_TIMEOUT,
  );

  it(
    'transcribes an in-memory WAV on a ZDR endpoint and hears no speech in a tone',
    async () => {
      setBotDbForTesting(new BotDb(':memory:'));
      const transcriber = new AudioTranscriber({
        client: getOpenRouterClient,
        fetch: files,
        transcoder: createFakeTranscoder({ probe: { durationSecs: 1.5, hasAudio: true, hasVideo: false } }),
        catalog,
      });
      const outcome = await transcriber.transcribe({ url: WAV_URL, messageId: 'live-wav', durationSecs: 1.5 });
      console.log(`MEDIA_LIVE transcription wav ${JSON.stringify(outcome)}`);
      expect(outcome.status).toBe('ok');
      setBotDbForTesting(undefined);
    },
    LIVE_TIMEOUT,
  );

  it(
    "sends Discord's Ogg/Opus as-is when ffmpeg is missing, and reports whether the endpoint took it",
    async () => {
      setBotDbForTesting(new BotDb(':memory:'));
      const transcriber = new AudioTranscriber({
        client: getOpenRouterClient,
        fetch: files,
        transcoder: createMissingTranscoder(),
        catalog,
      });
      const outcome = await transcriber.transcribe({ url: OGG_URL, messageId: 'live-ogg', durationSecs: 2 });
      // Reported, not asserted: prod transcodes Ogg to MP3 with ffmpeg; this only tells whether the
      // ffmpeg-less fallback would work on today's endpoints.
      console.log(`MEDIA_LIVE transcription ogg-native ${JSON.stringify(outcome)}`);
      expect(['ok', 'failed']).toContain(outcome.status);
      setBotDbForTesting(undefined);
    },
    LIVE_TIMEOUT,
  );

  it(
    'describes a clip sent whole with the configured VIDEO_MODEL',
    async () => {
      setBotDbForTesting(new BotDb(':memory:'));
      const transcriber = new AudioTranscriber({ client: getOpenRouterClient, fetch: files, transcoder: createMissingTranscoder(), catalog });
      const describer = new VideoDescriber({
        client: getOpenRouterClient,
        fetch: files,
        transcoder: createMissingTranscoder(),
        transcriber,
        inputMode: () => 'native',
        catalog,
      });
      const outcome = await describer.describe({ url: MP4_URL, contentType: 'video/mp4', durationSecs: 2 });
      console.log(`MEDIA_LIVE video ${config.media.videoModel} ${JSON.stringify(outcome)}`);
      expect(outcome.status).toBe('ok');
      setBotDbForTesting(undefined);
    },
    LIVE_TIMEOUT,
  );

  it.each(VIDEO_CANDIDATES)(
    'reports whether %s has a ZDR endpoint that takes base64 video',
    async (model) => {
      const client = getOpenRouterClient();
      if (!client) throw new Error('no client');
      const clip = fs.readFileSync(path.join(MEDIA_DIR, 'test-pattern.mp4')).toString('base64');
      const info = await catalog.info(model);
      try {
        const text = await completeMedia({
          client,
          model,
          feature: 'video',
          system: 'Describe videos in one short sentence.',
          content: [
            { type: 'video_url', video_url: { url: `data:video/mp4;base64,${clip}` } },
            { type: 'text', text: 'What is in this video?' },
          ],
          maxTokens: 512,
          timeoutMs: 90_000,
          reasoningEffort: info.lowestEffort,
        });
        console.log(`MEDIA_LIVE video-candidate model=${model} native=ok text=${JSON.stringify(text.slice(0, 200))}`);
      } catch (error) {
        console.log(`MEDIA_LIVE video-candidate model=${model} native=error ${describeError(error)}`);
      }
    },
    LIVE_TIMEOUT,
  );
});
