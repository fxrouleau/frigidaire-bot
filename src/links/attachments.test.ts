import { describe, expect, it } from 'vitest';
import { type AttachmentSource, downloadAttachments, formatSize } from './attachments';

const source = (name: string, size: number): AttachmentSource => ({ url: `https://cdn.test/${name}`, name, size });

function fetchServing(bodies: Record<string, () => Response>): typeof globalThis.fetch & { urls: string[] } {
  const urls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const make = bodies[url];
    if (!make) throw new TypeError('fetch failed');
    return make();
  }) as typeof globalThis.fetch;
  return Object.assign(fn, { urls });
}

/** A body streamed in chunks without a content-length (so only the streaming cap can stop it). */
function streamed(chunks: number, chunkSize: number): () => Response {
  return () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= chunks) controller.close();
        else controller.enqueue(new Uint8Array(chunkSize));
      },
    });
    return new Response(stream);
  };
}

describe('downloadAttachments', () => {
  it('is a no-op without attachments', async () => {
    const fetch = fetchServing({});
    expect(await downloadAttachments([], { fetch, maxTotalBytes: 10 })).toEqual({ ok: true, files: [] });
    expect(fetch.urls).toEqual([]);
  });

  it('downloads every attachment, keeping names and alt text', async () => {
    const fetch = fetchServing({
      'https://cdn.test/a.png': () => new Response(new Uint8Array([1, 2])),
      'https://cdn.test/SPOILER_b.gif': () => new Response(new Uint8Array([3])),
    });

    const result = await downloadAttachments(
      [{ ...source('a.png', 2), description: 'alt' }, source('SPOILER_b.gif', 1)],
      { fetch, maxTotalBytes: 10 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((f) => [f.name, f.description, [...f.attachment]])).toEqual([
      ['a.png', 'alt', [1, 2]],
      ['SPOILER_b.gif', undefined, [3]],
    ]);
  });

  it("refuses on Discord's declared sizes before downloading anything", async () => {
    const fetch = fetchServing({});
    const result = await downloadAttachments([source('a', 6), source('b', 6)], { fetch, maxTotalBytes: 10 });
    expect(result).toEqual({ ok: false, reason: 'attachments total 12 B, over the 10 B repost cap' });
    expect(fetch.urls).toEqual([]);
  });

  it('is all or nothing: one failed download fails the set', async () => {
    const fetch = fetchServing({ 'https://cdn.test/a': () => new Response(new Uint8Array([1])) });
    const result = await downloadAttachments([source('a', 1), source('b', 1)], { fetch, maxTotalBytes: 10 });
    expect(result).toEqual({ ok: false, reason: 'b failed to download (fetch failed)' });
  });

  it('stops reading a body that grows past the cap (declared sizes can lie)', async () => {
    const fetch = fetchServing({ 'https://cdn.test/a': streamed(100, 1024) });
    const result = await downloadAttachments([source('a', 10)], { fetch, maxTotalBytes: 4096 });
    expect(result).toEqual({ ok: false, reason: 'a is larger than 4 KB' });
  });

  it('refuses a body whose content-length is over the cap without reading it', async () => {
    const fetch = fetchServing({
      'https://cdn.test/a': () => new Response(new Uint8Array(64), { headers: { 'content-length': '999999' } }),
    });
    const result = await downloadAttachments([source('a', 10)], { fetch, maxTotalBytes: 100 });
    expect(result).toEqual({ ok: false, reason: 'a is larger than 100 B' });
  });

  it('refuses when the real bytes add up past the cap', async () => {
    const fetch = fetchServing({
      'https://cdn.test/a': () => new Response(new Uint8Array(60)),
      'https://cdn.test/b': () => new Response(new Uint8Array(60)),
    });
    const result = await downloadAttachments([source('a', 1), source('b', 1)], { fetch, maxTotalBytes: 100 });
    expect(result).toEqual({ ok: false, reason: 'attachments total 120 B, over the 100 B repost cap' });
  });

  it('reports HTTP errors (expired CDN links)', async () => {
    const fetch = fetchServing({ 'https://cdn.test/a': () => new Response('', { status: 404 }) });
    expect(await downloadAttachments([source('a', 1)], { fetch, maxTotalBytes: 100 })).toEqual({
      ok: false,
      reason: 'a answered HTTP 404',
    });
  });
});

describe('formatSize', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [4096, '4 KB'],
    [10 * 1024 * 1024, '10.0 MB'],
  ])('%d → %s', (bytes, text) => {
    expect(formatSize(bytes)).toBe(text);
  });
});
