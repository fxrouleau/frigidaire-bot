import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import { type FakeRoute, createFakeSafeFetch, htmlPage } from '../../test-support/fakeSafeFetch';
import { createLinkEnricher } from './enricher';
import { LinkReader } from './reader';

const API = 'https://api.fxtwitter.com/2/status/';
const image = { contentType: 'image/jpeg', body: Buffer.alloc(4) };

const tweet = (id: string, photos: string[] = []) => ({
  code: 200,
  status: {
    url: `https://x.com/someone/status/${id}`,
    text: `tweet number ${id}`,
    author: { screen_name: 'someone', name: 'Some One' },
    media: { photos: photos.map((url) => ({ url })) },
  },
});

function setup(routes: Record<string, FakeRoute>, budgetMs?: number) {
  const fetch = createFakeSafeFetch(routes);
  const reader = new LinkReader({ fetch, describeVideo: async () => undefined });
  return { fetch, reader, enricher: createLinkEnricher({ reader: () => reader, budgetMs }) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('link enricher', () => {
  it('previews a link in the message being answered, with vetted images', async () => {
    const { enricher } = setup({
      [`${API}111`]: { body: tweet('111', ['https://pbs.twimg.com/media/a.jpg', 'https://pbs.twimg.com/media/b.jpg']) },
      'https://pbs.twimg.com/media/a.jpg': image,
      'https://pbs.twimg.com/media/b.jpg': { contentType: 'text/html', body: '<html></html>' },
    });
    const { message } = createFakeMessage({ content: '<@bot-1> thoughts? https://x.com/someone/status/111' });
    expect(await enricher.enrich(message, 'current')).toEqual([
      { type: 'text', text: '[link: https://x.com/someone/status/111 — tweet by Some One (@someone): tweet number 111 [2 images]]' },
      { type: 'image', url: 'https://pbs.twimg.com/media/a.jpg?name=medium' },
    ]);
  });

  it('treats the replied-to message the same way', async () => {
    const { enricher, fetch } = setup({ [`${API}111`]: { body: tweet('111') } });
    const { message } = createFakeMessage({ content: 'https://fixvx.com/someone/status/111' });
    const parts = await enricher.enrich(message, 'reference');
    expect(parts).toHaveLength(1);
    expect(fetch.calls).toHaveLength(1);
  });

  it('never fetches for history messages, but reuses cached previews (text only)', async () => {
    const { enricher, fetch, reader } = setup({
      [`${API}111`]: { body: tweet('111', ['https://pbs.twimg.com/media/a.jpg']) },
      'https://pbs.twimg.com/media/a.jpg': image,
    });
    const { message } = createFakeMessage({ content: 'https://x.com/someone/status/111' });
    expect(await enricher.enrich(message, 'history')).toEqual([]);
    expect(fetch.calls).toHaveLength(0);

    await reader.read('https://x.com/someone/status/111');
    const parts = await enricher.enrich(message, 'history');
    expect(parts).toEqual([
      { type: 'text', text: '[link: https://x.com/someone/status/111 — tweet by Some One (@someone): tweet number 111 [1 image]]' },
    ]);
    expect(fetch.calls).toHaveLength(1);
  });

  it('skips suppressed and code links, and reads at most 3 links', async () => {
    const { enricher, fetch } = setup({ [API]: (url) => ({ body: tweet(url.slice(API.length).split('?')[0]) }) });
    const { message } = createFakeMessage({
      content:
        '<https://x.com/a/status/11> `https://x.com/a/status/12` https://x.com/a/status/13 https://x.com/a/status/14 https://x.com/a/status/15 https://x.com/a/status/16',
    });
    const parts = await enricher.enrich(message, 'current');
    expect(parts.map((p) => (p.type === 'text' ? p.text.slice(0, 41) : p.type))).toEqual([
      '[link: https://x.com/a/status/13 — tweet ',
      '[link: https://x.com/a/status/14 — tweet ',
      '[link: https://x.com/a/status/15 — tweet ',
    ]);
    expect(fetch.calls.map((c) => c.url)).toEqual([`${API}13?lang=en`, `${API}14?lang=en`, `${API}15?lang=en`]);
  });

  it('caps images across the whole message', async () => {
    const routes: Record<string, FakeRoute> = { 'https://pbs.twimg.com/': image };
    for (const id of ['21', '22', '23']) {
      routes[`${API}${id}`] = { body: tweet(id, [`https://pbs.twimg.com/media/${id}a.jpg`, `https://pbs.twimg.com/media/${id}b.jpg`]) };
    }
    const { enricher } = setup(routes);
    const { message } = createFakeMessage({ content: 'https://x.com/a/status/21 https://x.com/a/status/22 https://x.com/a/status/23' });
    const parts = await enricher.enrich(message, 'current');
    expect(parts.filter((p) => p.type === 'text')).toHaveLength(3);
    expect(parts.filter((p) => p.type === 'image')).toHaveLength(4);
  });

  it("adds no images when Discord already rendered this link's embed image", async () => {
    const { enricher, fetch } = setup({
      [`${API}111`]: { body: tweet('111', ['https://pbs.twimg.com/media/a.jpg']) },
      'https://pbs.twimg.com/media/a.jpg': image,
    });
    const { message } = createFakeMessage({
      content: 'https://x.com/someone/status/111',
      embeds: [{ url: 'https://fixvx.com/someone/status/111', imageUrl: 'https://pbs.twimg.com/media/a.jpg' }],
    });
    const parts = await enricher.enrich(message, 'current');
    expect(parts.map((p) => p.type)).toEqual(['text']);
    expect(fetch.calls.map((c) => c.url)).toEqual([`${API}111?lang=en`]);
  });

  it('says so when a link could not be opened', async () => {
    const { enricher } = setup({ 'https://gone.example/': { status: 404, body: htmlPage({}) } });
    const { message } = createFakeMessage({ content: 'https://gone.example/' });
    expect(await enricher.enrich(message, 'current')).toEqual([
      { type: 'text', text: "[link: https://gone.example/ — couldn't open it: that page does not exist (HTTP 404)]" },
    ]);
  });

  it('gives up on a slow site within its budget, leaving the read to finish into the cache', async () => {
    const { enricher, reader } = setup(
      {
        [`${API}111`]: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return { body: tweet('111') };
        },
      },
      10,
    );
    const { message } = createFakeMessage({ content: 'https://x.com/someone/status/111' });
    expect(await enricher.enrich(message, 'current')).toEqual([
      { type: 'text', text: '[link: https://x.com/someone/status/111 — the site is slow; read_link can still open it]' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reader.peek('https://x.com/someone/status/111')?.ok).toBe(true);
  });

  it.each([['LINK_READER_ENABLED'], ['LINK_PREVIEWS_ENABLED']])('does nothing when %s is off', async (name) => {
    vi.stubEnv(name, 'false');
    const { enricher, fetch } = setup({});
    const { message } = createFakeMessage({ content: 'https://x.com/someone/status/111' });
    expect(await enricher.enrich(message, 'current')).toEqual([]);
    expect(fetch.calls).toHaveLength(0);
  });

  it('does nothing for messages without links', async () => {
    const { enricher } = setup({});
    const { message } = createFakeMessage({ content: 'no links, just vibes' });
    expect(await enricher.enrich(message, 'current')).toEqual([]);
  });
});
