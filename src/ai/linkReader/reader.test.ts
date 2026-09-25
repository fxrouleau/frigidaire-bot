import { afterEach, describe, expect, it, vi } from 'vitest';
import { type FakeRoute, createFakeSafeFetch } from '../../test-support/fakeSafeFetch';
import type { VideoInput, VideoOutcome } from '../media';
import { BlockedUrlError } from './netGuard';
import { LinkReader, getLinkReader, setLinkReaderForTesting } from './reader';
import type { LinkVideo } from './types';

const API = 'https://api.fxtwitter.com/2/status/';

const tweet = (id: string, extra: Record<string, unknown> = {}) => ({
  code: 200,
  status: {
    url: `https://x.com/someone/status/${id}`,
    text: `tweet ${id}`,
    author: { screen_name: 'someone', name: 'Some One' },
    likes: 1,
    ...extra,
  },
});

const videoTweet = (duration: number) =>
  tweet('222', {
    media: {
      videos: [
        {
          url: 'https://video.twimg.com/v.mp4',
          thumbnail_url: 'https://pbs.twimg.com/thumb.jpg',
          duration,
          formats: [{ url: 'https://video.twimg.com/v.mp4', container: 'mp4', bitrate: 800000 }],
        },
      ],
    },
  });

// A string = what video understanding says; an outcome = why it said nothing; `null` = it failed upstream.
function setup(
  routes: Record<string, FakeRoute>,
  describeResult: string | VideoOutcome | null = 'a cat knocks a glass off a table',
) {
  let now = 1_000_000;
  const fetch = createFakeSafeFetch(routes);
  const describeVideo = vi.fn(async (_input: VideoInput): Promise<VideoOutcome> => {
    if (describeResult === null) return { status: 'failed' };
    return typeof describeResult === 'string' ? { status: 'ok', text: describeResult, cached: false } : describeResult;
  });
  const reader = new LinkReader({ fetch, now: () => now, watchVideo: describeVideo });
  return {
    reader,
    fetch,
    describeVideo,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  setLinkReaderForTesting(undefined);
});

describe('LinkReader.read', () => {
  it('caches per canonical link, so the fixer repost shares the original tweet read', async () => {
    const { reader, fetch } = setup({ [`${API}111`]: { body: tweet('111') } });
    const first = await reader.read('https://x.com/someone/status/111');
    const second = await reader.read('https://fixvx.com/someone/status/111?s=20');
    expect(first).toEqual(second);
    expect(first.ok && first.content.text).toBe('tweet 111');
    expect(fetch.calls).toHaveLength(1);
    expect(reader.peek('https://twitter.com/someone/status/111')).toEqual(first);
    expect(reader.keyFor('https://vxtwitter.com/x/status/111')).toBe('twitter:111');
  });

  it('de-duplicates concurrent reads of the same link', async () => {
    const { reader, fetch } = setup({
      [`${API}111`]: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { body: tweet('111') };
      },
    });
    const [a, b] = await Promise.all([reader.read('https://x.com/a/status/111'), reader.read('https://x.com/b/status/111')]);
    expect(a).toEqual(b);
    expect(fetch.calls).toHaveLength(1);
  });

  it('expires successes after an hour', async () => {
    const { reader, fetch, advance } = setup({ [`${API}111`]: { body: tweet('111') } });
    await reader.read('https://x.com/a/status/111');
    advance(59 * 60 * 1000);
    await reader.read('https://x.com/a/status/111');
    expect(fetch.calls).toHaveLength(1);
    advance(2 * 60 * 1000);
    await reader.read('https://x.com/a/status/111');
    expect(fetch.calls).toHaveLength(2);
  });

  it('retries transient failures after a couple of minutes but remembers "deleted" longer', async () => {
    const { reader, fetch, advance } = setup({
      [`${API}500`]: new Error('socket hang up'),
      'https://fixvx.com/': { status: 500, body: '' },
      'https://fxtwitter.com/': { status: 500, body: '' },
      [`${API}404`]: { status: 404, body: { code: 404, status: null } },
    });
    const transient = await reader.read('https://x.com/a/status/500');
    expect(transient).toEqual({ ok: false, url: 'https://x.com/a/status/500', error: "couldn't load it (socket hang up)" });
    const deleted = await reader.read('https://x.com/a/status/404');
    expect(deleted).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist/) });

    const apiCalls = () => fetch.calls.filter((c) => c.url.startsWith(API)).length;
    expect(apiCalls()).toBe(2);
    advance(3 * 60 * 1000);
    await reader.read('https://x.com/a/status/500');
    await reader.read('https://x.com/a/status/404');
    expect(apiCalls()).toBe(3);
    advance(15 * 60 * 1000);
    await reader.read('https://x.com/a/status/404');
    expect(apiCalls()).toBe(4);
  });

  it('refuses private or malformed URLs without any request', async () => {
    const { reader, fetch } = setup({});
    for (const url of ['http://sandbox:8080/run', 'http://169.254.169.254/latest/meta-data/', 'ftp://example.com/', 'http://localhost/']) {
      const result = await reader.read(url);
      expect(result).toMatchObject({ ok: false, url, error: expect.stringMatching(/^refused to open it/) });
    }
    expect(fetch.calls).toHaveLength(0);
    expect(reader.peek('http://sandbox:8080/run')).toBeUndefined();
  });

  it('reports a redirect into a private network as refused', async () => {
    const { reader } = setup({ 'https://evil.example/': new BlockedUrlError('sandbox is not a public hostname') });
    expect(await reader.read('https://evil.example/')).toEqual({
      ok: false,
      url: 'https://evil.example/',
      error: 'refused to open it (sandbox is not a public hostname)',
    });
  });

  it('re-dispatches a shortener that lands on a platform to that platform extractor', async () => {
    const { reader, fetch } = setup({
      'https://t.co/abc': { finalUrl: 'https://x.com/someone/status/333', body: '<html></html>' },
      [`${API}333`]: { body: tweet('333') },
    });
    const result = await reader.read('https://t.co/abc');
    expect(result.ok && result.content).toMatchObject({ source: 'twitter', text: 'tweet 333' });
    expect(fetch.calls.map((c) => c.url)).toEqual(['https://t.co/abc', `${API}333?lang=en`]);
  });
});

describe('LinkReader video understanding', () => {
  const mp4 = { contentType: 'video/mp4', headers: { 'content-length': '3000000' }, body: Buffer.alloc(4) };

  it('describes the first video only when asked, with the vetted final URL, and caches it', async () => {
    const { reader, describeVideo, fetch } = setup({
      [`${API}222`]: { body: videoTweet(12) },
      'https://video.twimg.com/v.mp4': { ...mp4, finalUrl: 'https://video.twimg.com/v.mp4?final=1' },
    });
    const preview = await reader.read('https://x.com/a/status/222');
    expect(describeVideo).not.toHaveBeenCalled();
    expect(preview.ok && (preview.content.media[0] as LinkVideo).description).toBeUndefined();

    const watched = await reader.read('https://x.com/a/status/222', { watchVideos: true });
    expect(describeVideo).toHaveBeenCalledTimes(1);
    expect(describeVideo.mock.calls[0][0]).toEqual({
      url: 'https://video.twimg.com/v.mp4?final=1',
      contentType: 'video/mp4',
      context: 'A tweet posted by @someone; caption: tweet 222',
      durationSecs: 12,
    });
    // The media probe never downloads the body.
    expect(fetch.calls.find((c) => c.url === 'https://video.twimg.com/v.mp4')?.options.accept).toEqual([]);
    expect(watched.ok && (watched.content.media[0] as LinkVideo).description).toBe('a cat knocks a glass off a table');

    await reader.read('https://x.com/a/status/222', { watchVideos: true });
    expect(describeVideo).toHaveBeenCalledTimes(1);
    const cached = reader.peek('https://x.com/a/status/222');
    expect(cached?.ok && (cached.content.media[0] as LinkVideo).description).toBe('a cat knocks a glass off a table');
  });

  it('hands a long video over too, with its duration, so the media feature skims it', async () => {
    const { reader, describeVideo } = setup({ [`${API}222`]: { body: videoTweet(1200) }, 'https://video.twimg.com/v.mp4': mp4 });
    const result = await reader.read('https://x.com/a/status/222', { watchVideos: true });
    expect(describeVideo).toHaveBeenCalledTimes(1);
    expect(describeVideo.mock.calls[0][0]).toMatchObject({ url: 'https://video.twimg.com/v.mp4', durationSecs: 1200 });
    expect(result.ok && (result.content.media[0] as LinkVideo).description).toBe('a cat knocks a glass off a table');
  });

  it('says so when the video file is over the download cap', async () => {
    const { reader } = setup(
      { [`${API}222`]: { body: videoTweet(1200) }, 'https://video.twimg.com/v.mp4': mp4 },
      { status: 'too_large' },
    );
    const result = await reader.read('https://x.com/a/status/222', { watchVideos: true });
    expect(result.ok && (result.content.media[0] as LinkVideo).note).toBe('too large to watch');
  });

  it('honors LINK_READER_WATCH_VIDEOS=false (off)', async () => {
    vi.stubEnv('LINK_READER_WATCH_VIDEOS', 'false');
    const { reader, describeVideo } = setup({ [`${API}222`]: { body: videoTweet(12) }, 'https://video.twimg.com/v.mp4': mp4 });
    const result = await reader.read('https://x.com/a/status/222', { watchVideos: true });
    expect(describeVideo).not.toHaveBeenCalled();
    expect(result.ok && (result.content.media[0] as LinkVideo).note).toBe('video understanding is turned off');
  });

  it('notes an unreachable or non-video file', async () => {
    const { reader, describeVideo } = setup({
      [`${API}222`]: { body: videoTweet(12) },
      'https://video.twimg.com/v.mp4': { contentType: 'text/html', body: '<html>login</html>' },
    });
    const result = await reader.read('https://x.com/a/status/222', { watchVideos: true });
    expect(describeVideo).not.toHaveBeenCalled();
    expect(result.ok && (result.content.media[0] as LinkVideo).note).toBe("the video file couldn't be opened");
  });

  it('notes when video understanding has nothing to say', async () => {
    const { reader } = setup({ [`${API}222`]: { body: videoTweet(12) }, 'https://video.twimg.com/v.mp4': mp4 }, null);
    const result = await reader.read('https://x.com/a/status/222', { watchVideos: true });
    expect(result.ok && (result.content.media[0] as LinkVideo).note).toBe('video understanding is unavailable right now');
  });

  it("says so, in character, when today's video budget is spent", async () => {
    const { reader } = setup(
      { [`${API}222`]: { body: videoTweet(12) }, 'https://video.twimg.com/v.mp4': mp4 },
      { status: 'over_budget' },
    );
    const result = await reader.read('https://x.com/a/status/222', { watchVideos: true });
    expect(result.ok && (result.content.media[0] as LinkVideo).note).toBe(
      'not watched: out of popcorn money for today, the daily video budget is spent',
    );
  });
});

describe('LinkReader: a question about the video', () => {
  const mp4 = { contentType: 'video/mp4', headers: { 'content-length': '3000000' }, body: Buffer.alloc(4) };

  it('watches the first video to answer it, without caching the answer with the content', async () => {
    const { reader, describeVideo } = setup(
      { [`${API}222`]: { body: videoTweet(12) }, 'https://video.twimg.com/v.mp4': mp4 },
      'he says "run it back"',
    );
    const result = await reader.read('https://x.com/a/status/222', { question: 'what does he say at the end?' });

    expect(describeVideo.mock.calls[0][0]).toMatchObject({
      url: 'https://video.twimg.com/v.mp4',
      question: 'what does he say at the end?',
    });
    expect(result.ok && (result.content.media[0] as LinkVideo).answer).toEqual({
      question: 'what does he say at the end?',
      text: 'he says "run it back"',
    });
    const cached = reader.peek('https://x.com/a/status/222');
    expect(cached?.ok && (cached.content.media[0] as LinkVideo).answer).toBeUndefined();
  });

  it("can't watch a video without a file (YouTube), and says so", async () => {
    const { reader, describeVideo } = setup({});
    const content = {
      url: 'https://www.youtube.com/watch?v=x',
      source: 'youtube' as const,
      kind: 'youtube video' as const,
      media: [
        {
          type: 'video' as const,
          pageUrl: 'https://www.youtube.com/watch?v=x',
          note: "YouTube doesn't expose the video file; going by title and description",
        },
      ],
    };
    // What the YouTube extractor returns, without scripting its HTTP exchange.
    vi.spyOn(reader as unknown as { extract: () => Promise<unknown> }, 'extract').mockResolvedValue({
      result: { ok: true, content },
      videosDescribed: false,
    });
    const result = await reader.read('https://www.youtube.com/watch?v=x', { question: 'who wins?' });
    expect(describeVideo).not.toHaveBeenCalled();
    expect(result.ok && (result.content.media[0] as LinkVideo).note).toBe(
      "YouTube doesn't expose the video file; going by title and description; can't watch this one",
    );
  });

  it('notes a link without any video', async () => {
    const { reader, describeVideo } = setup({ [`${API}111`]: { body: tweet('111') } });
    const result = await reader.read('https://x.com/a/status/111', { question: 'who wins?' });
    expect(describeVideo).not.toHaveBeenCalled();
    expect(result.ok && result.content.notes).toEqual(['no video in this link to watch']);
  });
});

describe('LinkReader.previewImages', () => {
  const content = {
    url: 'https://news.example/a',
    source: 'web' as const,
    kind: 'article' as const,
    media: [
      { type: 'image' as const, url: 'https://img.example/redirecting.jpg' },
      { type: 'image' as const, url: 'https://img.example/not-an-image' },
      { type: 'image' as const, url: 'https://img.example/to-internal.jpg' },
      { type: 'image' as const, url: 'https://img.example/logo.svg' },
      { type: 'image' as const, url: 'https://img.example/ok.webp' },
    ],
  };

  it('keeps only vetted images, passing on the redirect-free final URL', async () => {
    const { reader } = setup({
      'https://img.example/redirecting.jpg': { finalUrl: 'https://cdn.example/final.jpg', contentType: 'image/jpeg', body: Buffer.alloc(4) },
      'https://img.example/not-an-image': { contentType: 'text/html', body: '<html></html>' },
      'https://img.example/to-internal.jpg': new BlockedUrlError('sandbox is not a public hostname'),
      'https://img.example/logo.svg': { contentType: 'image/svg+xml', body: '<svg/>' },
      'https://img.example/ok.webp': { contentType: 'application/octet-stream', body: Buffer.alloc(4) },
    });
    expect(await reader.previewImages(content, 2)).toEqual(['https://cdn.example/final.jpg']);
    const more = { ...content, media: [...content.media.slice(3), content.media[0]] };
    expect(await reader.previewImages(more, 2)).toEqual(['https://img.example/ok.webp', 'https://cdn.example/final.jpg']);
  });

  it('uses only previously vetted images in cache-only mode', async () => {
    const { reader, fetch } = setup({
      'https://img.example/redirecting.jpg': { contentType: 'image/jpeg', body: Buffer.alloc(4) },
    });
    expect(await reader.previewImages(content, 2, { cacheOnly: true })).toEqual([]);
    await reader.previewImages({ ...content, media: [content.media[0]] }, 1);
    const calls = fetch.calls.length;
    expect(await reader.previewImages(content, 2, { cacheOnly: true })).toEqual(['https://img.example/redirecting.jpg']);
    expect(fetch.calls).toHaveLength(calls);
  });

  it('offers video thumbnails as images', async () => {
    const { reader } = setup({ 'https://pbs.twimg.com/thumb.jpg': { contentType: 'image/jpeg', body: Buffer.alloc(4) } });
    const video = { ...content, media: [{ type: 'video' as const, url: 'https://video.example/v.mp4', thumbnailUrl: 'https://pbs.twimg.com/thumb.jpg' }] };
    expect(await reader.previewImages(video, 2)).toEqual(['https://pbs.twimg.com/thumb.jpg']);
  });
});

describe('getLinkReader', () => {
  it('never reaches the network under tests', async () => {
    const result = await getLinkReader().read('https://example.com/');
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/network access is disabled in tests/) });
  });
});
