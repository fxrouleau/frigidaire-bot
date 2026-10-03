// The only place the bot shells out: ffmpeg/ffprobe for audio transcoding, duration probes, video
// keyframe sampling and shrinking a video under an upload limit. Everything above this module talks to the MediaTranscoder interface, so tests
// inject a fake and never need ffmpeg installed.
//
// Inputs are written to a private temp directory rather than piped: MP4s with the index (moov atom)
// at the end can't be demuxed from a non-seekable pipe, and phone-recorded clips often look like that.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from '../../logger';

export type ProbeResult = { durationSecs?: number; hasAudio: boolean; hasVideo: boolean };

export type VideoSample = {
  durationSecs?: number;
  /** JPEG frames in playback order. */
  frames: Buffer[];
  /** The audio track as mono MP3 (cut at maxAudioSeconds); undefined when the clip has no audio track. */
  audio?: Buffer;
};

export type ShrunkVideo = { data: Buffer; durationSecs: number };

export interface MediaTranscoder {
  /** Stream layout and duration of a media file. Throws when the probe itself fails. */
  probe(input: Buffer): Promise<ProbeResult>;
  /**
   * The first audio track as 16 kHz mono MP3, cut at `maxSeconds`, plus the source's duration.
   * Undefined when the input has no audio track. Throws when transcoding fails.
   */
  toMp3(input: Buffer, maxSeconds: number): Promise<{ data: Buffer; durationSecs?: number } | undefined>;
  /** Evenly spaced keyframes (≤ maxDimension px on the long side) plus the audio track. */
  sampleVideo(
    input: Buffer,
    opts: { frames: number; maxDimension: number; maxAudioSeconds: number },
  ): Promise<VideoSample>;
  /**
   * The video re-encoded (H.264/AAC MP4, metadata stripped) to fit in `maxBytes`: the bitrate follows from
   * the length, the size from the bitrate. Undefined when it can't be done well: no picture, a length
   * over `maxSeconds` or unknown, or still too big after one lower-quality retry. Throws when ffmpeg fails.
   */
  shrinkVideo(input: Buffer, opts: { maxBytes: number; maxSeconds: number }): Promise<ShrunkVideo | undefined>;
}

type RunResult = { stdout: Buffer; stderr: string };

const DEFAULT_TIMEOUT_MS = 90_000;
// Re-encoding a few minutes of phone video takes longer than any probe or sample.
const DEFAULT_SHRINK_TIMEOUT_MS = 240_000;
// What the bitrate leaves for picture and sound once the container and the encoder's overshoot are paid for.
const SHRINK_HEADROOM = 0.92;
// Below this the picture is mush: better not to post it at all.
const MIN_SHRINK_VIDEO_KBPS = 150;
// ffmpeg is CPU-heavy; two at a time keeps a burst of voice messages from starving the event loop's host.
const MAX_CONCURRENT = 2;
const STDERR_LIMIT = 4000;

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export type FfmpegTranscoderOptions = {
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
  shrinkTimeoutMs?: number;
};

/** The long side for a video bitrate: 720p when there are bits for it, down to 360p. */
function shrinkDimension(videoKbps: number): number {
  if (videoKbps >= 1000) return 1280;
  if (videoKbps >= 500) return 854;
  return 640;
}

export class FfmpegTranscoder implements MediaTranscoder {
  private readonly ffmpeg: string;
  private readonly ffprobe: string;
  private readonly timeoutMs: number;
  private readonly shrinkTimeoutMs: number;
  private readonly slots = new Semaphore(MAX_CONCURRENT);

  constructor(opts: FfmpegTranscoderOptions = {}) {
    this.ffmpeg = opts.ffmpegPath ?? 'ffmpeg';
    this.ffprobe = opts.ffprobePath ?? 'ffprobe';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.shrinkTimeoutMs = opts.shrinkTimeoutMs ?? DEFAULT_SHRINK_TIMEOUT_MS;
  }

  probe(input: Buffer): Promise<ProbeResult> {
    return this.withInput(input, (file) => this.probeFile(file));
  }

  toMp3(input: Buffer, maxSeconds: number): Promise<{ data: Buffer; durationSecs?: number } | undefined> {
    return this.withInput(input, async (file, dir) => {
      const probe = await this.probeFile(file);
      if (!probe.hasAudio) return undefined;
      const data = await this.extractMp3(file, dir, maxSeconds);
      return { data, durationSecs: probe.durationSecs };
    });
  }

  sampleVideo(
    input: Buffer,
    opts: { frames: number; maxDimension: number; maxAudioSeconds: number },
  ): Promise<VideoSample> {
    return this.withInput(input, async (file, dir) => {
      const probe = await this.probeFile(file);
      const frames = probe.hasVideo ? await this.extractFrames(file, dir, probe.durationSecs, opts) : [];
      let audio: Buffer | undefined;
      if (probe.hasAudio) {
        try {
          audio = await this.extractMp3(file, dir, opts.maxAudioSeconds);
        } catch (error) {
          // A broken audio track shouldn't cost the visual description.
          logger.warn('media: could not extract a video’s audio track:', error);
        }
      }
      return { durationSecs: probe.durationSecs, frames, audio };
    });
  }

  shrinkVideo(input: Buffer, opts: { maxBytes: number; maxSeconds: number }): Promise<ShrunkVideo | undefined> {
    return this.withInput(input, async (file, dir) => {
      const probe = await this.probeFile(file);
      const durationSecs = probe.durationSecs;
      if (!probe.hasVideo || !durationSecs || durationSecs > opts.maxSeconds) return undefined;
      let totalKbps = (opts.maxBytes * 8 * SHRINK_HEADROOM) / durationSecs / 1000;
      for (let attempt = 0; attempt < 2; attempt++) {
        const audioKbps = probe.hasAudio ? (totalKbps >= 800 ? 96 : 64) : 0;
        const videoKbps = Math.floor(totalKbps - audioKbps);
        if (videoKbps < MIN_SHRINK_VIDEO_KBPS) return undefined;
        const max = shrinkDimension(videoKbps);
        const out = path.join(dir, `shrunk-${attempt}.mp4`);
        await this.run(
          this.ffmpeg,
          [
            ...['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file],
            ...['-map', '0:v:0', ...(probe.hasAudio ? ['-map', '0:a:0'] : []), '-sn', '-dn', '-map_metadata', '-1'],
            '-vf',
            `scale=w='min(${max},iw)':h='min(${max},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
            ...['-fpsmax', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'],
            ...[
              '-b:v',
              `${videoKbps}k`,
              '-maxrate',
              `${Math.floor(videoKbps * 1.5)}k`,
              '-bufsize',
              `${videoKbps * 2}k`,
            ],
            ...(probe.hasAudio ? ['-c:a', 'aac', '-b:a', `${audioKbps}k`, '-ac', '2'] : ['-an']),
            ...['-movflags', '+faststart', '-f', 'mp4', out],
          ],
          this.shrinkTimeoutMs,
        );
        const data = await fs.readFile(out);
        if (data.byteLength <= opts.maxBytes) return { data, durationSecs };
        // The encoder overshot (busy footage): aim lower by what it missed, plus a margin.
        totalKbps *= (opts.maxBytes / data.byteLength) * 0.9;
      }
      return undefined;
    });
  }

  private async withInput<T>(input: Buffer, fn: (file: string, dir: string) => Promise<T>): Promise<T> {
    return this.slots.run(async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frigidaire-media-'));
      try {
        const file = path.join(dir, 'input');
        await fs.writeFile(file, input);
        return await fn(file, dir);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch((error) => {
          logger.warn(`media: failed to clean up ${dir}:`, error);
        });
      }
    });
  }

  private async probeFile(file: string): Promise<ProbeResult> {
    const { stdout } = await this.run(this.ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type',
      '-of',
      'json',
      file,
    ]);
    const parsed = JSON.parse(stdout.toString('utf8')) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string }>;
    };
    const duration = Number(parsed.format?.duration);
    const streams = parsed.streams ?? [];
    return {
      durationSecs: Number.isFinite(duration) && duration > 0 ? duration : undefined,
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
      hasVideo: streams.some((s) => s.codec_type === 'video'),
    };
  }

  private async extractMp3(file: string, dir: string, maxSeconds: number): Promise<Buffer> {
    const out = path.join(dir, `audio-${Date.now()}.mp3`);
    // Mono 16 kHz at 48 kbps: models downsample speech to 16 kHz anyway, and it keeps a 10-minute
    // voice message around 3.6 MB before base64.
    await this.run(this.ffmpeg, [
      ...['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file],
      ...['-map', '0:a:0', '-vn', '-sn', '-dn', '-t', String(maxSeconds)],
      ...['-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3', out],
    ]);
    return fs.readFile(out);
  }

  private async extractFrames(
    file: string,
    dir: string,
    durationSecs: number | undefined,
    opts: { frames: number; maxDimension: number },
  ): Promise<Buffer[]> {
    const max = opts.maxDimension;
    const scale = `scale=w='min(${max},iw)':h='min(${max},ih)':force_original_aspect_ratio=decrease`;
    const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];

    if (!durationSecs) {
      // Unknown length (some WebM/streams): one frame every 2 s from the start.
      const pattern = path.join(dir, 'frame-%02d.jpg');
      await this.run(this.ffmpeg, [
        ...common,
        ...['-i', file, '-vf', `fps=1/2,${scale}`, '-frames:v', String(opts.frames), '-q:v', '4', pattern],
      ]);
      const names = (await fs.readdir(dir)).filter((n) => n.startsWith('frame-')).sort();
      return Promise.all(names.map((n) => fs.readFile(path.join(dir, n))));
    }

    // One frame per ~2 s of footage, capped: a 4-second meme needs 2 frames, not 8.
    const count = Math.max(1, Math.min(opts.frames, Math.ceil(durationSecs / 2)));
    const frames: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      // Seeking before -i jumps via the index instead of decoding everything up to the timestamp.
      const at = ((durationSecs * (i + 0.5)) / count).toFixed(2);
      const out = path.join(dir, `frame-${i}.jpg`);
      try {
        await this.run(this.ffmpeg, [
          ...common,
          '-ss',
          at,
          '-i',
          file,
          '-frames:v',
          '1',
          '-vf',
          scale,
          '-q:v',
          '4',
          out,
        ]);
        frames.push(await fs.readFile(out));
      } catch (error) {
        // A seek past the last keyframe yields no frame; the others are still worth sending.
        logger.warn(`media: frame at ${at}s failed:`, error);
      }
    }
    return frames;
  }

  private run(command: string, args: string[], timeoutMs = this.timeoutMs): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8');
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(error.code === 'ENOENT' ? new Error(`${command} is not installed (spawn ENOENT)`) : error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout: Buffer.concat(stdout), stderr });
        } else {
          reject(new Error(`${command} exited with code ${code}: ${stderr.trim().slice(-500)}`));
        }
      });
    });
  }
}
