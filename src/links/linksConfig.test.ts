import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BLUESKY_FIXERS, DEFAULT_REDDIT_FIXERS, config } from '../config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('config.links', () => {
  it('has sensible defaults', () => {
    expect(config.links.redditFixers).toEqual(DEFAULT_REDDIT_FIXERS);
    expect(config.links.blueskyFixers).toEqual(DEFAULT_BLUESKY_FIXERS);
    expect(config.links.maxRepostAttachmentBytes).toBe(10 * 1024 * 1024);
    expect(config.links.twitterTranslateTo).toBe('en');
    expect(config.links.alertsEnabled).toBe(true);
    expect(config.links.alertMinIntervalMs).toBe(6 * 60 * 60 * 1000);
  });

  it('reads fixer list overrides', () => {
    vi.stubEnv('REDDIT_FIXERS', ' rxddit.com , vxreddit.com ');
    vi.stubEnv('BLUESKY_FIXERS', 'bskx.app');
    expect(config.links.redditFixers).toEqual(['rxddit.com', 'vxreddit.com']);
    expect(config.links.blueskyFixers).toEqual(['bskx.app']);
  });

  it.each([
    ['', undefined],
    ['   ', undefined],
    ['off', undefined],
    ['none', undefined],
    ['0', undefined],
    ['fr', 'fr'],
    ['PT-br', 'pt-br'],
    ['"de"', 'de'],
    ['not a language!', 'en'],
  ])('TWITTER_TRANSLATE_TO=%j → %s', (value, expected) => {
    vi.stubEnv('TWITTER_TRANSLATE_TO', value);
    expect(config.links.twitterTranslateTo).toBe(expected);
  });

  it('allows a 0-byte attachment cap (attachment-free reposts only) but not a negative one', () => {
    vi.stubEnv('LINK_REPOST_MAX_ATTACHMENT_BYTES', '0');
    expect(config.links.maxRepostAttachmentBytes).toBe(0);
    vi.stubEnv('LINK_REPOST_MAX_ATTACHMENT_BYTES', '-5');
    expect(config.links.maxRepostAttachmentBytes).toBe(10 * 1024 * 1024);
  });
});
