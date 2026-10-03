// FfmpegTranscoder against stand-in executables (always run: no ffmpeg needed) and, where ffmpeg is
// installed, against the real thing on media it generates itself. CI's test image has no ffmpeg, so
// the second block only runs on dev machines and in the prod-like environment.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FfmpegTranscoder } from './transcoder';

const HAS_FFMPEG =
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

let scratch: string;

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'transcoder-test-'));
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function script(name: string, body: string): string {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

describe('FfmpegTranscoder (stand-in executables)', () => {
  it('parses ffprobe output', async () => {
    const ffprobe = script(
      'probe-ok',
      `echo '{"format":{"duration":"12.500"},"streams":[{"codec_type":"video"},{"codec_type":"audio"}]}'`,
    );
    const transcoder = new FfmpegTranscoder({ ffprobePath: ffprobe });
    expect(await transcoder.probe(Buffer.from('x'))).toEqual({ durationSecs: 12.5, hasAudio: true, hasVideo: true });
  });

  it('reports an unknown duration as undefined', async () => {
    const ffprobe = script('probe-na', `echo '{"format":{"duration":"N/A"},"streams":[{"codec_type":"audio"}]}'`);
    const transcoder = new FfmpegTranscoder({ ffprobePath: ffprobe });
    expect(await transcoder.probe(Buffer.from('x'))).toEqual({ durationSecs: undefined, hasAudio: true, hasVideo: false });
  });

  it('skips transcoding for files without an audio track', async () => {
    const ffprobe = script('probe-silent', `echo '{"format":{"duration":"3"},"streams":[{"codec_type":"video"}]}'`);
    const ffmpeg = script('ffmpeg-unreachable', 'exit 1');
    const transcoder = new FfmpegTranscoder({ ffprobePath: ffprobe, ffmpegPath: ffmpeg });
    expect(await transcoder.toMp3(Buffer.from('x'), 60)).toBeUndefined();
  });

  it('says clearly when ffmpeg is not installed', async () => {
    const transcoder = new FfmpegTranscoder({ ffprobePath: path.join(scratch, 'no-such-ffprobe') });
    await expect(transcoder.probe(Buffer.from('x'))).rejects.toThrow(/is not installed/);
  });

  it('surfaces the tail of stderr when the tool fails', async () => {
    const ffprobe = script('probe-fail', 'echo "input: Invalid data found when processing input" >&2; exit 1');
    const transcoder = new FfmpegTranscoder({ ffprobePath: ffprobe });
    await expect(transcoder.probe(Buffer.from('x'))).rejects.toThrow(/exited with code 1: .*Invalid data found/);
  });

  it('kills a hung process at the timeout', async () => {
    const ffprobe = script('probe-hang', 'sleep 5');
    const transcoder = new FfmpegTranscoder({ ffprobePath: ffprobe, timeoutMs: 150 });
    await expect(transcoder.probe(Buffer.from('x'))).rejects.toThrow(/timed out after 150ms/);
  });

  it("won't shrink a video it can't make fit well: no picture, too long, or too long for the bytes", async () => {
    const unreachable = script('ffmpeg-never', 'exit 1');
    const shrink = async (probeJson: string, opts: { maxBytes: number; maxSeconds: number }) => {
      const ffprobe = script(`probe-${Math.random().toString(36).slice(2)}`, `echo '${probeJson}'`);
      return new FfmpegTranscoder({ ffprobePath: ffprobe, ffmpegPath: unreachable }).shrinkVideo(Buffer.from('x'), opts);
    };
    const audioOnly = '{"format":{"duration":"30"},"streams":[{"codec_type":"audio"}]}';
    const tenMinutes = '{"format":{"duration":"600"},"streams":[{"codec_type":"video"},{"codec_type":"audio"}]}';
    const oneMinute = '{"format":{"duration":"60"},"streams":[{"codec_type":"video"},{"codec_type":"audio"}]}';
    const unknownLength = '{"format":{"duration":"N/A"},"streams":[{"codec_type":"video"}]}';

    expect(await shrink(audioOnly, { maxBytes: 10_000_000, maxSeconds: 300 })).toBeUndefined();
    expect(await shrink(tenMinutes, { maxBytes: 10_000_000, maxSeconds: 300 })).toBeUndefined();
    expect(await shrink(unknownLength, { maxBytes: 10_000_000, maxSeconds: 300 })).toBeUndefined();
    // 1 MB for a minute leaves ~120 kbps: mush, not a video.
    expect(await shrink(oneMinute, { maxBytes: 1_000_000, maxSeconds: 300 })).toBeUndefined();
  });

  /** A stand-in ffmpeg that logs its arguments and writes outputs of the given sizes, one per run. */
  function shrinkingFfmpeg(name: string, sizes: number[]): { ffmpeg: string; runs: () => string[][] } {
    const log = path.join(scratch, `${name}.log`);
    const cases = sizes.map((size, i) => `${i + 1}) head -c ${size} /dev/zero > "$last" ;;`).join(' ');
    const ffmpeg = script(
      name,
      `for last; do :; done\nprintf '%s\\n' "$*" >> "${log}"\nn=$(($(wc -l < "${log}")))\ncase $n in ${cases} esac`,
    );
    return {
      ffmpeg,
      runs: () =>
        fs.existsSync(log)
          ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split(' '))
          : [],
    };
  }

  const TWO_MINUTES = '{"format":{"duration":"120"},"streams":[{"codec_type":"video"},{"codec_type":"audio"}]}';

  it('shrinks to a bitrate the length allows, picks the size from it, and strips metadata', async () => {
    const ffprobe = script('probe-two-minutes', `echo '${TWO_MINUTES}'`);
    const { ffmpeg, runs } = shrinkingFfmpeg('ffmpeg-fits', [900_000]);
    const transcoder = new FfmpegTranscoder({ ffprobePath: ffprobe, ffmpegPath: ffmpeg });

    const shrunk = await transcoder.shrinkVideo(Buffer.from('x'), { maxBytes: 10_000_000, maxSeconds: 300 });

    expect(shrunk?.data.byteLength).toBe(900_000);
    expect(shrunk?.durationSecs).toBe(120);
    const [args] = runs();
    const arg = (flag: string) => args[args.indexOf(flag) + 1];
    // 10 MB × 8 × 0.92 over 120 s ≈ 613 kbps: 64k of sound, the rest picture, at 480p.
    expect(arg('-b:a')).toBe('64k');
    expect(arg('-b:v')).toBe('549k');
    expect(arg('-vf')).toContain('min(854,iw)');
    expect(arg('-map_metadata')).toBe('-1');
    expect(arg('-c:v')).toBe('libx264');
    expect(args.at(-1)?.endsWith('.mp4')).toBe(true);
  });

  it('aims lower once when the encoder overshoots, and gives up after a second miss', async () => {
    const ffprobe = script('probe-two-minutes-2', `echo '${TWO_MINUTES}'`);
    const retried = shrinkingFfmpeg('ffmpeg-overshoots-once', [12_000_000, 9_000_000]);
    const once = new FfmpegTranscoder({ ffprobePath: ffprobe, ffmpegPath: retried.ffmpeg });
    expect((await once.shrinkVideo(Buffer.from('x'), { maxBytes: 10_000_000, maxSeconds: 300 }))?.data.byteLength).toBe(
      9_000_000,
    );
    const [first, second] = retried.runs();
    const rate = (args: string[]) => Number.parseInt(args[args.indexOf('-b:v') + 1], 10);
    expect(rate(second)).toBeLessThan(rate(first) * 0.8);

    const missed = shrinkingFfmpeg('ffmpeg-overshoots-twice', [12_000_000, 11_000_000]);
    const twice = new FfmpegTranscoder({ ffprobePath: ffprobe, ffmpegPath: missed.ffmpeg });
    expect(await twice.shrinkVideo(Buffer.from('x'), { maxBytes: 10_000_000, maxSeconds: 300 })).toBeUndefined();
    expect(missed.runs()).toHaveLength(2);
  });

  it('cleans up its temp directory', async () => {
    const ffprobe = script('probe-cleanup', `echo '{"format":{},"streams":[]}'`);
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('frigidaire-media-')).length;
    await new FfmpegTranscoder({ ffprobePath: ffprobe }).probe(Buffer.from('x'));
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('frigidaire-media-')).length;
    expect(after).toBeLessThanOrEqual(before);
  });
});

describe.skipIf(!HAS_FFMPEG)('FfmpegTranscoder (real ffmpeg)', () => {
  const transcoder = new FfmpegTranscoder();

  function generate(name: string, args: string[]): Buffer {
    const out = path.join(scratch, name);
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, out]);
    if (result.status !== 0) throw new Error(`could not generate ${name}: ${result.stderr.toString()}`);
    return fs.readFileSync(out);
  }

  it('probes and transcodes an Ogg/Opus voice message to mono MP3', async () => {
    const ogg = generate('voice.ogg', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libopus']);

    const probe = await transcoder.probe(ogg);
    expect(probe.hasAudio).toBe(true);
    expect(probe.hasVideo).toBe(false);
    expect(probe.durationSecs).toBeCloseTo(3, 0);

    const mp3 = await transcoder.toMp3(ogg, 600);
    expect(mp3?.durationSecs).toBeCloseTo(3, 0);
    // ffmpeg's MP3 muxer leads with an ID3v2 tag; a bare MPEG frame sync word is fine too.
    const head = mp3?.data.subarray(0, 3);
    expect(head?.toString('latin1') === 'ID3' || (head?.[0] === 0xff && ((head?.[1] ?? 0) & 0xe0) === 0xe0)).toBe(true);
  });

  it('cuts audio at maxSeconds', async () => {
    const wav = generate('long.wav', ['-f', 'lavfi', '-i', 'sine=frequency=300:duration=6']);
    const full = await transcoder.toMp3(wav, 600);
    const cut = await transcoder.toMp3(wav, 2);
    expect(cut?.data.byteLength).toBeLessThan((full?.data.byteLength ?? 0) / 2);
  });

  it('samples keyframes and the audio track from a clip', async () => {
    const mp4 = generate('clip.mp4', [
      ...['-f', 'lavfi', '-i', 'testsrc=duration=4:size=1280x720:rate=10'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=500:duration=4'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
    ]);

    const sample = await transcoder.sampleVideo(mp4, { frames: 8, maxDimension: 768, maxAudioSeconds: 600 });

    // One frame per ~2 s of footage: a 4-second clip gets 2, not 8.
    expect(sample.frames).toHaveLength(2);
    for (const frame of sample.frames) expect([frame[0], frame[1]]).toEqual([0xff, 0xd8]);
    expect(sample.audio?.byteLength).toBeGreaterThan(0);
    expect(sample.durationSecs).toBeCloseTo(4, 0);
  });

  it('samples a silent clip without an audio track', async () => {
    const mp4 = generate('silent.mp4', [
      ...['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
    ]);
    const sample = await transcoder.sampleVideo(mp4, { frames: 8, maxDimension: 768, maxAudioSeconds: 600 });
    expect(sample.frames.length).toBeGreaterThan(0);
    expect(sample.audio).toBeUndefined();
    expect(await transcoder.toMp3(mp4, 600)).toBeUndefined();
  });

  it('rejects files that are not media', async () => {
    await expect(transcoder.probe(Buffer.from('definitely not a video'))).rejects.toThrow();
  });

  it('shrinks a busy portrait clip under the byte limit, long side bounded, metadata gone', async () => {
    const mp4 = generate('busy.mp4', [
      ...['-f', 'lavfi', '-i', 'testsrc2=duration=6:size=720x1280:rate=24,noise=alls=40:allf=t'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=500:duration=6'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '6M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
      ...['-metadata', 'title=somewhere private'],
    ]);
    const maxBytes = 400_000;
    expect(mp4.byteLength).toBeGreaterThan(maxBytes * 5);

    const shrunk = await transcoder.shrinkVideo(mp4, { maxBytes, maxSeconds: 300 });

    expect(shrunk).toBeDefined();
    expect(shrunk?.data.byteLength).toBeLessThanOrEqual(maxBytes);
    expect(shrunk?.durationSecs).toBeCloseTo(6, 0);
    const out = path.join(scratch, 'shrunk.mp4');
    fs.writeFileSync(out, shrunk?.data ?? Buffer.alloc(0));
    const info = JSON.parse(
      spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out]).stdout.toString(),
    ) as { streams: Array<{ codec_type: string; width?: number; height?: number }>; format: { tags?: Record<string, string> } };
    const video = info.streams.find((stream) => stream.codec_type === 'video');
    expect([video?.width, video?.height]).toEqual([360, 640]);
    expect(info.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);
    expect(info.format.tags?.title).toBeUndefined();
  });
});
