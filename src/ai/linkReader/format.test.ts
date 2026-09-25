import { describe, expect, it } from 'vitest';
import { UNTRUSTED_HEADER, formatCount, formatLinkForTool, formatLinkPreview } from './format';
import type { LinkContent } from './types';

const tweet: LinkContent = {
  url: 'https://x.com/someone/status/111',
  source: 'twitter',
  kind: 'tweet',
  author: 'Some One',
  handle: 'someone',
  publishedAt: Date.parse('2026-09-20T16:30:00Z'),
  text: 'これはテストです',
  language: 'ja',
  translation: { from: 'ja', text: 'This is a test' },
  replyingTo: 'other',
  quote: { author: 'Quoted Person', handle: 'quoted', text: 'the original take', media: '2 photos', url: 'https://x.com/quoted/status/9' },
  stats: { likes: 1234, reposts: 56_789, views: 1_500_000, replies: 1 },
  media: [
    { type: 'image', url: 'https://pbs.twimg.com/media/a.jpg?name=medium', alt: 'a cat' },
    { type: 'video', url: 'https://video.twimg.com/v.mp4', durationSecs: 42, description: 'The cat jumps onto the fridge.' },
  ],
  notes: ['community note: context'],
};

describe('small formatters', () => {
  it('formats counts compactly past 10k', () => {
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(56_789)).toBe('56.8K');
    expect(formatCount(1_500_000)).toBe('1.5M');
  });
});

describe('formatLinkForTool', () => {
  it('renders every field as labeled lines behind the untrusted-content header', () => {
    expect(formatLinkForTool({ ok: true, content: tweet })).toBe(
      [
        UNTRUSTED_HEADER,
        'tweet by Some One (@someone) — https://x.com/someone/status/111',
        'posted: 2026-09-20 12:30 ET',
        'language: ja',
        'stats: 1.5M views · 1,234 likes · 56.8K reposts · 1 reply',
        'replying to: @other',
        'text:',
        'これはテストです',
        'English translation (from ja):',
        'This is a test',
        'quoting Quoted Person (@quoted) (https://x.com/quoted/status/9):',
        'the original take [2 photos]',
        'media:',
        '- image: https://pbs.twimg.com/media/a.jpg?name=medium (alt: a cat)',
        '- video (0:42): The cat jumps onto the fridge.',
        'notes: community note: context',
      ].join('\n'),
    );
  });

  it('renders comments, truncation and undescribed videos', () => {
    const text = formatLinkForTool({
      ok: true,
      content: {
        url: 'https://www.reddit.com/r/x/comments/1/',
        source: 'reddit',
        kind: 'reddit post',
        title: 'A title',
        author: 'u/poster',
        site: 'r/x',
        text: 'long text…',
        textTruncated: true,
        comments: [{ author: 'u/a', text: 'first!', score: 12 }],
        media: [{ type: 'video', pageUrl: 'https://www.youtube.com/watch?v=x', note: "YouTube doesn't expose the video file" }],
      },
    });
    expect(text).toContain('reddit post "A title" by u/poster on r/x — https://www.reddit.com/r/x/comments/1/');
    expect(text).toContain('long text…\n[text truncated]');
    expect(text).toContain('top comments:\n- u/a (12 points): first!');
    expect(text).toContain("- video: YouTube doesn't expose the video file — https://www.youtube.com/watch?v=x");
  });

  it('renders failures plainly', () => {
    expect(formatLinkForTool({ ok: false, url: 'https://x.example/', error: 'the site took too long to answer' })).toBe(
      "Couldn't read https://x.example/: the site took too long to answer",
    );
  });
});

describe('formatLinkPreview', () => {
  it('is one compact line with the translation, quote and media summary', () => {
    expect(formatLinkPreview('https://fixvx.com/someone/status/111', { ok: true, content: tweet })).toBe(
      '[link: https://fixvx.com/someone/status/111 — tweet by Some One (@someone): This is a test (translated from ja) ' +
        '[quoting Quoted Person (@quoted): the original take | 1 image | video 0:42: The cat jumps onto the fridge.]]',
    );
  });

  it('hints that an unwatched video can be opened with read_link', () => {
    const content: LinkContent = {
      url: 'https://www.tiktok.com/@a/video/1',
      source: 'tiktok',
      kind: 'tiktok',
      handle: 'a',
      text: 'caption',
      media: [{ type: 'video', url: 'https://tnktok.com/v.mp4' }],
    };
    expect(formatLinkPreview('https://www.tiktok.com/@a/video/1', { ok: true, content })).toBe(
      '[link: https://www.tiktok.com/@a/video/1 — tiktok by @a: caption [video, not watched yet (read_link watches it)]]',
    );
  });

  it('caps the text at about 500 characters on one line', () => {
    const content: LinkContent = { url: 'u', source: 'web', kind: 'article', title: 'T', text: `${'a\n'.repeat(400)}end`, media: [] };
    const preview = formatLinkPreview('https://x.example/', { ok: true, content });
    expect(preview).not.toContain('\n');
    expect(preview).toContain('…');
    expect(preview.length).toBeLessThan(600);
  });

  it('says why a link could not be opened', () => {
    expect(formatLinkPreview('https://x.example/', { ok: false, url: 'https://x.example/', error: 'that page does not exist (HTTP 404)' })).toBe(
      "[link: https://x.example/ — couldn't open it: that page does not exist (HTTP 404)]",
    );
  });

  it("doesn't count a GIF's own still as extra images", () => {
    const gif: LinkContent = {
      url: 'https://klipy.com/gifs/x',
      source: 'klipy',
      kind: 'gif',
      title: 'Cat Reaction',
      site: 'Klipy',
      media: [{ type: 'image', url: 'https://static.klipy.com/x.jpg' }],
    };
    expect(formatLinkPreview('https://klipy.com/gifs/x', { ok: true, content: gif })).toBe(
      '[link: https://klipy.com/gifs/x — gif "Cat Reaction" on Klipy]',
    );
  });
});
