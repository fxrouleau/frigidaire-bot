import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { LinkReadResult } from './ai/linkReader/types';
import { describeForJudge, framePicks, type JudgeMediaDeps, type SnapshotAttachment } from './deletedMessageMedia';

const KLIPY_URL = 'https://klipy.com/gifs/some-reaction';
const KLIPY_STILL = 'https://static.klipy.com/still.webp';
const TENOR_URL = 'https://tenor.com/view/cat-in-a-tie-gif-123456789';

const KLIPY_GIF: LinkReadResult = {
  ok: true,
  content: {
    url: KLIPY_URL,
    source: 'klipy',
    kind: 'gif',
    title: 'Some Reaction',
    site: 'Klipy',
    text: 'tags: reaction, shocked',
    textTruncated: false,
    media: [{ type: 'image', url: KLIPY_STILL, alt: 'Some Reaction' }],
  },
};

function picture(color: string, width = 1200, height = 600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

async function animatedGif(colors: string[]): Promise<Buffer> {
  const frames = await Promise.all(colors.map((color) => picture(color, 40, 20)));
  return sharp(frames, { join: { animated: true } })
    .gif()
    .toBuffer();
}

/** The top-left pixel of a data-URI JPEG: which frame was picked. */
async function firstPixel(uri: string): Promise<number[]> {
  const data = Buffer.from(uri.slice('data:image/jpeg;base64,'.length), 'base64');
  return [...(await sharp(data).raw().toBuffer()).subarray(0, 3)];
}

async function sizeOf(uri: string): Promise<[number | undefined, number | undefined]> {
  const meta = await sharp(Buffer.from(uri.split(',')[1], 'base64')).metadata();
  return [meta.width, meta.height];
}

function fakeDeps(overrides: Partial<JudgeMediaDeps> = {}) {
  const read: string[] = [];
  const downloaded: string[] = [];
  const transcribed: Array<{ label: string; durationSecs?: number }> = [];
  const deps: JudgeMediaDeps = {
    readLink: async (url) => {
      read.push(url);
      return { ok: false, url, error: 'offline' };
    },
    downloadImage: async (url) => {
      downloaded.push(url);
      return undefined;
    },
    sampleVideo: async () => {
      throw new Error('ffmpeg is not installed (spawn ENOENT)');
    },
    transcribe: async (_audio, label, durationSecs) => {
      transcribed.push({ label, durationSecs });
      return undefined;
    },
    ...overrides,
  };
  return { deps, read, downloaded, transcribed };
}

/** n red, n green and n blue frames, each a slightly different shade (the GIF encoder merges identical frames). */
const RGB = (n: number) =>
  ['ff0000', '00ff00', '0000ff'].flatMap((hex) =>
    Array.from({ length: n }, (_, i) => `#${hex.replace(/ff/, (0xff - i * 8).toString(16))}`),
  );

describe('framePicks', () => {
  it('takes evenly spaced frames from the middle of each stretch, never more than there are', () => {
    expect(framePicks(12, 3)).toEqual([2, 6, 10]);
    expect(framePicks(12, 6)).toEqual([1, 3, 5, 7, 9, 11]);
    expect(framePicks(2, 6)).toEqual([0, 1]);
    expect(framePicks(1, 3)).toEqual([0]);
  });
});

describe('describeForJudge', () => {
  it("shows the judge a GIF from Discord's picker: the page's words and its still", async () => {
    const still = await picture('#ff0000');
    const { deps, read, downloaded } = fakeDeps({
      readLink: async (url) => {
        read.push(url);
        return KLIPY_GIF;
      },
      downloadImage: async (url) => {
        downloaded.push(url);
        return url === KLIPY_STILL ? still : undefined;
      },
    });

    const media = await describeForJudge(`lol ${KLIPY_URL}`, [], deps);

    expect(read).toEqual([KLIPY_URL]);
    expect(downloaded).toEqual([KLIPY_STILL]);
    expect(media.notes).toEqual(['gif on Klipy "Some Reaction": tags: reaction, shocked']);
    expect(media.visuals.map((v) => v.label)).toEqual(['GIF from Klipy "Some Reaction" (its still)']);
    expect(media.visuals[0].frames).toHaveLength(1);
    expect(media.visuals[0].frames[0].startsWith('data:image/jpeg;base64,')).toBe(true);
    // Downscaled for the judge.
    expect(await sizeOf(media.visuals[0].frames[0])).toEqual([768, 384]);
  });

  it("keeps the GIF's words when its still can't be fetched, and reads Tenor links too", async () => {
    const { deps, read } = fakeDeps({
      readLink: async (url) => {
        read.push(url);
        return {
          ok: true,
          content: {
            url: TENOR_URL,
            source: 'tenor',
            kind: 'gif',
            title: 'Cat In A Tie',
            site: 'Tenor',
            text: 'a black cat wearing a striped tie\ntags: cat, tie',
            textTruncated: false,
            media: [{ type: 'image', url: 'https://media.tenor.com/x/still.png' }],
          },
        };
      },
    });

    const media = await describeForJudge(TENOR_URL, [], deps);

    expect(read).toEqual([TENOR_URL]);
    expect(media).toEqual({
      visuals: [],
      notes: ['gif on Tenor "Cat In A Tie": a black cat wearing a striped tie tags: cat, tie'],
      unreadableLinks: [],
    });
  });

  it('judges a GIF page it could not read on the text alone (its slug names the GIF)', async () => {
    const { deps } = fakeDeps();
    expect(await describeForJudge(KLIPY_URL, [], deps)).toEqual({ visuals: [], notes: [], unreadableLinks: [] });
  });

  it('only opens GIF pages and image files: other links, code and <…>-suppressed links stay unread', async () => {
    const { deps, read, downloaded } = fakeDeps();

    await describeForJudge(
      'https://x.com/someone/status/123 https://example.com/article `https://klipy.com/gifs/in-code` <https://tenor.com/view/hidden-gif-123456789>',
      [],
      deps,
    );

    expect(read).toEqual([]);
    expect(downloaded).toEqual([]);
  });

  it("downloads linked image files: a favorited GIF on Discord's CDN, a media.tenor.com file", async () => {
    const gif = await animatedGif(['#ff0000', '#00ff00', '#0000ff']);
    const favorite = `https://cdn.discordapp.com/attachments/1/2/dance.gif?ex=${(2 ** 31 - 1).toString(16)}&is=2&hm=3`;
    const tenorFile = 'https://media.tenor.com/abc/AAAAC/dance.gif';
    const signed: string[][] = [];
    const { deps, downloaded } = fakeDeps({
      downloadImage: async (url) => {
        downloaded.push(url);
        return gif;
      },
      signUrls: async (urls) => {
        signed.push(urls);
        return new Map();
      },
    });

    const media = await describeForJudge(`${favorite} and ${tenorFile}`, [], deps);

    // A link still validly signed (and anything not on Discord's CDN) is fetched as written.
    expect(signed).toEqual([]);
    expect(downloaded).toEqual([favorite, tenorFile]);
    // Named by file: Discord's CDN links carry signing parameters.
    expect(media.visuals.map((v) => v.label)).toEqual([
      expect.stringMatching(/^linked GIF dance\.gif \(animated, 3 frames( over [\d.]+ s)?\): 3 frames in order$/),
      expect.stringMatching(/^linked GIF dance\.gif \(animated, 3 frames( over [\d.]+ s)?\): 3 frames in order$/),
    ]);
    expect(media.notes).toEqual(['linked animated image dance.gif', 'linked animated image dance.gif']);
  });

  it("signs a favorite's unsigned CDN link before downloading it, and shows a lone GIF in six frames", async () => {
    const gif = await animatedGif(RGB(4));
    // As Discord's picker posts it: no signature, on the media proxy, an uppercase name, an extra parameter.
    const favorite = 'https://media.discordapp.net/attachments/1/2/DANCE.GIF?backend=b2';
    const signedUrl = 'https://media.discordapp.net/attachments/1/2/DANCE.GIF?backend=b2&ex=ffffffff&is=1&hm=abc';
    const asked: string[][] = [];
    const { deps, downloaded } = fakeDeps({
      signUrls: async (urls) => {
        asked.push(urls);
        return new Map([[favorite, signedUrl]]);
      },
      // The CDN refuses the unsigned link, as it does in real life.
      downloadImage: async (url) => {
        downloaded.push(url);
        return url === signedUrl ? gif : undefined;
      },
    });

    const media = await describeForJudge(favorite, [], deps);

    expect(asked).toEqual([[favorite]]);
    expect(downloaded).toEqual([signedUrl]);
    expect(media.unreadableLinks).toEqual([]);
    expect(media.visuals).toHaveLength(1);
    expect(media.visuals[0].label).toMatch(/^linked GIF DANCE\.GIF \(animated, 12 frames( over [\d.]+ s)?\): 6 frames in order$/);
    const pixels = await Promise.all(media.visuals[0].frames.map(firstPixel));
    expect(pixels.map((p) => p.indexOf(Math.max(...p)))).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('reports a linked image it could not open, so a message that was only that is not judged blind', async () => {
    const favorite = 'https://cdn.discordapp.com/attachments/1/2/dance.gif';
    const { deps } = fakeDeps({ signUrls: async () => new Map() });

    const media = await describeForJudge(`${favorite} `, [], deps);

    expect(media).toEqual({
      visuals: [],
      notes: ['linked GIF dance.gif (could not be opened)'],
      unreadableLinks: [favorite],
    });
  });

  it('shows frames from across an animated GIF, not just its first one: six when it is alone, three otherwise', async () => {
    const gif: SnapshotAttachment = { name: 'dance.gif', contentType: 'image/gif', data: await animatedGif(RGB(4)) };
    const still: SnapshotAttachment = { name: 'still.png', contentType: 'image/png', data: await picture('#000000') };
    const { deps } = fakeDeps();

    const alone = await describeForJudge('', [gif], deps);
    const withStill = await describeForJudge('', [gif, still], deps);

    expect(alone.notes).toEqual(['animated image dance.gif']);
    expect(alone.visuals[0].label).toMatch(/: 6 frames in order$/);
    const sixPixels = await Promise.all(alone.visuals[0].frames.map(firstPixel));
    expect(sixPixels.map((p) => p.indexOf(Math.max(...p)))).toEqual([0, 0, 1, 1, 2, 2]);
    expect(withStill.visuals.map((v) => v.frames.length)).toEqual([3, 1]);
    const [first, middle, last] = await Promise.all(withStill.visuals[0].frames.map(firstPixel));
    expect(first[0]).toBeGreaterThan(200); // red
    expect(middle[1]).toBeGreaterThan(200); // green
    expect(last[2]).toBeGreaterThan(200); // blue
    expect(withStill.visuals[1]).toEqual({ label: 'picture still.png', frames: [expect.any(String)] });
  });

  it('shows a still picture once, without a note (its name is already in the attachments line)', async () => {
    const { deps } = fakeDeps();
    const media = await describeForJudge(
      '',
      [{ name: 'spicy.png', contentType: 'image/png', data: await picture('#123456') }],
      deps,
    );
    expect(media.visuals).toEqual([{ label: 'picture spicy.png', frames: [expect.any(String)] }]);
    expect(media.notes).toEqual([]);
  });

  it('enlarges a tiny picture up to twice its size so a caption stays legible', async () => {
    const { deps } = fakeDeps();
    const media = await describeForJudge(
      '',
      [{ name: 'tiny.png', contentType: 'image/png', data: await picture('#123456', 100, 50) }],
      deps,
    );
    expect(await sizeOf(media.visuals[0].frames[0])).toEqual([200, 100]);
  });

  it("shows a video's keyframes and what's said in it", async () => {
    const frames = [Buffer.from('frame-1'), Buffer.from('frame-2'), Buffer.from('frame-3')];
    const sampled: Array<{ frames: number; maxDimension: number; maxAudioSeconds: number }> = [];
    const { deps, transcribed } = fakeDeps({
      sampleVideo: async (_input, opts) => {
        sampled.push(opts);
        return { durationSecs: 12.4, frames, audio: Buffer.from('mp3') };
      },
      transcribe: async (_audio, label, durationSecs) => {
        transcribed.push({ label, durationSecs });
        return 'you are   all\nclowns';
      },
    });

    const media = await describeForJudge(
      'watch this',
      [{ name: 'clip.mp4', contentType: 'video/mp4', data: Buffer.from('mp4') }],
      deps,
    );

    expect(sampled).toEqual([{ frames: 4, maxDimension: 768, maxAudioSeconds: 120 }]);
    expect(transcribed).toEqual([{ label: 'deleted video clip.mp4', durationSecs: 12.4 }]);
    expect(media.visuals).toEqual([
      {
        label: 'video clip.mp4 (0:12): 3 frames in order',
        frames: frames.map((f) => `data:image/jpeg;base64,${f.toString('base64')}`),
      },
    ]);
    expect(media.notes).toEqual(['video clip.mp4 (0:12), said: "you are all clowns"']);
  });

  it("says when a video has no speech, and still shows its frames when the soundtrack can't be transcribed", async () => {
    const silent = fakeDeps({
      sampleVideo: async () => ({ durationSecs: 5, frames: [Buffer.from('f')], audio: Buffer.from('mp3') }),
      transcribe: async () => '',
    });
    const failing = fakeDeps({
      sampleVideo: async () => ({ durationSecs: 300, frames: [Buffer.from('f')], audio: Buffer.from('mp3') }),
      transcribe: async () => {
        throw new Error('whisper is down');
      },
    });
    const clip: SnapshotAttachment = { name: 'clip.mov', contentType: 'video/quicktime', data: Buffer.from('mov') };

    expect((await describeForJudge('', [clip], silent.deps)).notes).toEqual(['video clip.mov (0:05), no speech']);
    expect(await describeForJudge('', [clip], failing.deps)).toEqual({
      visuals: [{ label: 'video clip.mov (5:00): one frame', frames: ['data:image/jpeg;base64,Zg=='] }],
      notes: ['video clip.mov (5:00)'],
      unreadableLinks: [],
    });
  });

  it('leaves out what it cannot open (no ffmpeg, an undecodable picture, an SVG) and keeps the rest', async () => {
    const { deps } = fakeDeps();
    const media = await describeForJudge(
      '',
      [
        { name: 'clip.mp4', contentType: 'video/mp4', data: Buffer.from('mp4') },
        { name: 'odd.png', contentType: 'image/png', data: Buffer.from('not a png') },
        { name: 'logo.svg', contentType: 'image/svg+xml', data: Buffer.from('<svg/>') },
        { name: 'ok.jpg', contentType: null, data: await picture('#abcdef') },
        { name: 'notes.txt', contentType: 'text/plain', data: Buffer.from('hi') },
      ],
      deps,
    );
    expect(media.visuals.map((v) => v.label)).toEqual(['picture ok.jpg']);
    expect(media.notes).toEqual([]);
  });

  it('caps what the judge sees: two videos, six images in all', async () => {
    let sampled = 0;
    const { deps } = fakeDeps({
      sampleVideo: async () => {
        sampled++;
        return { durationSecs: 8, frames: [1, 2, 3, 4].map((n) => Buffer.from(`f${n}`)) };
      },
    });
    const video = (n: number): SnapshotAttachment => ({ name: `v${n}.mp4`, contentType: 'video/mp4', data: Buffer.from('x') });

    const media = await describeForJudge('', [video(1), video(2), video(3)], deps);

    expect(sampled).toBe(2);
    expect(media.visuals.map((v) => [v.label, v.frames.length])).toEqual([
      ['video v1.mp4 (0:08): 4 frames in order', 4],
      ['video v2.mp4 (0:08): 2 frames in order', 2],
    ]);
    expect(media.notes).toEqual(['video v1.mp4 (0:08)', 'video v2.mp4 (0:08)']);
  });
});
