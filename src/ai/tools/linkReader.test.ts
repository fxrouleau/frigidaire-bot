import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import { FakeProvider } from '../../test-support/fakeProvider';
import { createFakeSafeFetch } from '../../test-support/fakeSafeFetch';
import { UNTRUSTED_HEADER } from '../linkReader/format';
import { LinkReader, setLinkReaderForTesting } from '../linkReader/reader';
import { type ToolHandlerContext, createTurnEffects } from '../types';
import { linkReaderTools, normalizeUrlArgument } from './linkReader';

const readLink = linkReaderTools[0];

function context(): ToolHandlerContext {
  const { message } = createFakeMessage({ content: 'what is this' });
  return { message, provider: new FakeProvider([]), channelId: 'channel-1', turn: createTurnEffects() };
}

function installReader() {
  const fetch = createFakeSafeFetch({
    'https://api.fxtwitter.com/2/status/': (url) => ({
      body: {
        code: 200,
        status: {
          url: 'https://x.com/someone/status/111',
          text: `tweet ${url.split('/').pop()?.split('?')[0]}`,
          author: { screen_name: 'someone', name: 'Some One' },
          media: {
            videos: [{ url: 'https://video.twimg.com/v.mp4', duration: 5, formats: [{ url: 'https://video.twimg.com/v.mp4', container: 'mp4' }] }],
          },
        },
      },
    }),
    'https://video.twimg.com/v.mp4': { contentType: 'video/mp4', body: Buffer.alloc(4) },
  });
  const describeVideo = vi.fn(async () => 'someone dances in a kitchen');
  setLinkReaderForTesting(new LinkReader({ fetch, describeVideo }));
  return { fetch, describeVideo };
}

afterEach(() => {
  setLinkReaderForTesting(undefined);
  vi.unstubAllEnvs();
});

describe('read_link', () => {
  it('is a single-url tool, offered only while the link reader is enabled', () => {
    expect(readLink.name).toBe('read_link');
    expect(readLink.parameters).toMatchObject({ required: ['url'] });
    expect(readLink.isEnabled?.()).toBe(true);
    vi.stubEnv('LINK_READER_ENABLED', 'off');
    expect(readLink.isEnabled?.()).toBe(false);
  });

  it('reads the link, watching its video', async () => {
    const { describeVideo } = installReader();
    const output = await readLink.handler(context(), { url: 'https://x.com/someone/status/111' });
    expect(output.startsWith(UNTRUSTED_HEADER)).toBe(true);
    expect(output).toContain('tweet by Some One (@someone) — https://x.com/someone/status/111');
    expect(output).toContain('tweet 111');
    expect(output).toContain('- video (0:05): someone dances in a kitchen');
    expect(describeVideo).toHaveBeenCalledTimes(1);
  });

  it('rejects arguments that are not a URL', async () => {
    const { fetch } = installReader();
    expect(await readLink.handler(context(), { url: 42 })).toBe('read_link needs a single http(s) URL.');
    expect(await readLink.handler(context(), { url: 'two words' })).toBe('read_link needs a single http(s) URL.');
    expect(await readLink.handler(context(), {})).toBe('read_link needs a single http(s) URL.');
    expect(fetch.calls).toHaveLength(0);
  });

  it('refuses internal addresses a page might have talked the model into', async () => {
    const { fetch } = installReader();
    const output = await readLink.handler(context(), { url: 'http://sandbox:8080/run' });
    expect(output).toBe("Couldn't read http://sandbox:8080/run: refused to open it (sandbox is not a public hostname)");
    expect(fetch.calls).toHaveLength(0);
  });

  it('caps the number of reads per turn', async () => {
    installReader();
    const ctx = context();
    for (let i = 0; i < 6; i++) {
      expect(await readLink.handler(ctx, { url: `https://x.com/someone/status/10${i}` })).toContain(UNTRUSTED_HEADER);
    }
    expect(await readLink.handler(ctx, { url: 'https://x.com/someone/status/200' })).toMatch(/Already opened 6 links this turn/);
    // A new turn starts fresh.
    expect(await readLink.handler(context(), { url: 'https://x.com/someone/status/200' })).toContain(UNTRUSTED_HEADER);
  });
});

describe('normalizeUrlArgument', () => {
  it.each([
    ['https://example.com/a', 'https://example.com/a'],
    ['  <https://example.com/a>  ', 'https://example.com/a'],
    ['"https://example.com/a"', 'https://example.com/a'],
    ['example.com/a', 'https://example.com/a'],
    ['//example.com/a', 'https://example.com/a'],
    ['ftp://example.com/a', 'ftp://example.com/a'], // left for the guard to refuse with a reason
  ])('normalizes %s', (input, expected) => {
    expect(normalizeUrlArgument(input)).toBe(expected);
  });

  it.each([[''], ['a b'], [undefined], [`https://example.com/${'a'.repeat(3000)}`]])('rejects %s', (input) => {
    expect(normalizeUrlArgument(input)).toBeUndefined();
  });
});
