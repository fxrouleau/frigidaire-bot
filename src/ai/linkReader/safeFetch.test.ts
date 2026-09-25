import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Resolver } from './netGuard';
import {
  BlockedUrlError,
  FetchFailedError,
  type HttpTransport,
  type TransportRequest,
  type TransportResponse,
  createSafeFetch,
  decodeText,
  mimeMatches,
  nodeTransport,
  parseContentType,
  parseJsonBody,
} from './safeFetch';

const resolver: Resolver = async (hostname) => {
  const table: Record<string, string> = {
    'site.example': '93.184.215.14',
    'cdn.example': '151.101.1.1',
    'evil.example': '93.184.215.99',
    'internal.example': '10.0.0.7',
  };
  const address = table[hostname];
  if (!address) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return [{ address, family: 4 }];
};

type Scripted = Partial<TransportResponse> & { status: number };

/** A transport answering from a URL → response table, recording what it was asked. */
function scriptedTransport(table: Record<string, Scripted>): HttpTransport & { requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  const transport = (async (request: TransportRequest) => {
    requests.push(request);
    const scripted = table[request.url.toString()];
    if (!scripted) return { status: 404, headers: {}, truncated: false };
    const headers = scripted.headers ?? {};
    const wanted = request.wantBody(scripted.status, headers['content-type'] ?? '', headers);
    return { status: scripted.status, headers, body: wanted ? scripted.body : undefined, truncated: scripted.truncated ?? false };
  }) as HttpTransport & { requests: TransportRequest[] };
  transport.requests = requests;
  return transport;
}

const html = (text: string): Scripted => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: Buffer.from(text),
});
const redirect = (location: string, status = 302): Scripted => ({ status, headers: { location } });

describe('createSafeFetch', () => {
  it('fetches a public page, pinning the connection to the checked addresses', async () => {
    const transport = scriptedTransport({ 'https://site.example/a': html('<p>hi</p>') });
    const fetch = createSafeFetch({ resolver, transport });
    const result = await fetch('https://site.example/a', { accept: ['text/html'] });
    expect(result).toMatchObject({ url: 'https://site.example/a', status: 200, ok: true, contentType: 'text/html', charset: 'utf-8' });
    expect(result.body?.toString()).toBe('<p>hi</p>');
    expect(transport.requests[0].addresses).toEqual([{ address: '93.184.215.14', family: 4 }]);
    expect(transport.requests[0].headers['user-agent']).toMatch(/Discordbot/);
  });

  it('follows redirects, re-checking every hop', async () => {
    const transport = scriptedTransport({
      'https://site.example/short': redirect('/long'),
      'https://site.example/long': redirect('https://cdn.example/final', 301),
      'https://cdn.example/final': html('done'),
    });
    const result = await createSafeFetch({ resolver, transport })('https://site.example/short', { accept: ['text/html'] });
    expect(result.url).toBe('https://cdn.example/final');
    expect(result.body?.toString()).toBe('done');
    expect(transport.requests.map((r) => r.addresses[0].address)).toEqual(['93.184.215.14', '93.184.215.14', '151.101.1.1']);
  });

  it.each([
    ['http://sandbox:8080/run', /not a public hostname/],
    ['http://169.254.169.254/latest/meta-data/', /link-local/],
    ['https://internal.example/admin', /private address/],
    ['http://127.0.0.1:8080/', /loopback/],
    ['file:///etc/passwd', /unsupported scheme/],
  ])('refuses a redirect to %s without contacting it', async (target, message) => {
    const transport = scriptedTransport({ 'https://evil.example/r': redirect(target) });
    const fetch = createSafeFetch({ resolver, transport });
    await expect(fetch('https://evil.example/r', { accept: ['text/html'] })).rejects.toThrow(message);
    await expect(fetch('https://evil.example/r', { accept: ['text/html'] })).rejects.toBeInstanceOf(BlockedUrlError);
    expect(transport.requests.every((r) => r.url.hostname === 'evil.example')).toBe(true);
  });

  it('refuses private targets before any request', async () => {
    const transport = scriptedTransport({});
    const fetch = createSafeFetch({ resolver, transport });
    await expect(fetch('https://internal.example/', { accept: ['text/html'] })).rejects.toThrow(BlockedUrlError);
    await expect(fetch('http://localhost:8080/', { accept: ['text/html'] })).rejects.toThrow(BlockedUrlError);
    expect(transport.requests).toHaveLength(0);
  });

  it('gives up after too many redirects', async () => {
    const table: Record<string, Scripted> = {};
    for (let i = 0; i < 10; i++) table[`https://site.example/${i}`] = redirect(`/${i + 1}`);
    const fetch = createSafeFetch({ resolver, transport: scriptedTransport(table) });
    const error = await fetch('https://site.example/0', { accept: ['text/html'] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchFailedError);
    expect((error as FetchFailedError).reason).toBe('redirects');
  });

  it("returns the first redirect's target with redirect: 'manual'", async () => {
    const transport = scriptedTransport({ 'https://site.example/s/abc': redirect('https://cdn.example/post/1?x=1') });
    const result = await createSafeFetch({ resolver, transport })('https://site.example/s/abc', { accept: [], redirect: 'manual' });
    expect(result.status).toBe(302);
    expect(result.location).toBe('https://cdn.example/post/1?x=1');
    expect(transport.requests).toHaveLength(1);
  });

  it('only downloads bodies whose type is accepted', async () => {
    const transport = scriptedTransport({
      'https://cdn.example/video.mp4': { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '999999999' }, body: Buffer.from('x') },
    });
    const result = await createSafeFetch({ resolver, transport })('https://cdn.example/video.mp4', { accept: ['text/html'] });
    expect(result.contentType).toBe('video/mp4');
    expect(result.body).toBeUndefined();
  });

  it('skips a body declared over the cap only when asked to (a truncated page is still useful)', async () => {
    const transport = scriptedTransport({
      'https://cdn.example/big': { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '5000' }, body: Buffer.from('x') },
    });
    const fetch = createSafeFetch({ resolver, transport });
    const options = { accept: ['video/*'], maxBytes: 100 };
    expect((await fetch('https://cdn.example/big', options)).body?.toString()).toBe('x');
    const skipped = await fetch('https://cdn.example/big', { ...options, skipOversizedBody: true });
    expect(skipped).toMatchObject({ ok: true, contentType: 'video/mp4', truncated: false });
    expect(skipped.body).toBeUndefined();
    expect((await fetch('https://cdn.example/big', { ...options, maxBytes: 5000, skipOversizedBody: true })).body).toBeDefined();
  });

  it('turns a hung request into a timeout error', async () => {
    const hanging: HttpTransport = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason));
      });
    const error = await createSafeFetch({ resolver, transport: hanging })('https://site.example/', { accept: ['text/html'], timeoutMs: 20 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FetchFailedError);
    expect((error as FetchFailedError).reason).toBe('timeout');
  });

  it('reports network errors with their code', async () => {
    const failing: HttpTransport = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    await expect(createSafeFetch({ resolver, transport: failing })('https://site.example/', { accept: [] })).rejects.toThrow(
      'network error (ECONNREFUSED)',
    );
  });

  it('refuses unresolvable hosts as blocked', async () => {
    await expect(createSafeFetch({ resolver, transport: scriptedTransport({}) })('https://nowhere.example/', { accept: [] })).rejects.toThrow(
      /could not resolve nowhere.example/,
    );
  });
});

describe('helpers', () => {
  it('parseContentType splits the MIME type and charset', () => {
    expect(parseContentType('text/HTML; Charset="ISO-8859-1"')).toEqual({ mime: 'text/html', charset: 'ISO-8859-1' });
    expect(parseContentType(undefined)).toEqual({ mime: '' });
    expect(parseContentType('application/json')).toEqual({ mime: 'application/json', charset: undefined });
  });

  it('mimeMatches handles exact, wildcard and structured-suffix patterns', () => {
    expect(mimeMatches('image/png', ['image/*'])).toBe(true);
    expect(mimeMatches('application/ld+json', ['*+json'])).toBe(true);
    expect(mimeMatches('text/html', ['text/plain'])).toBe(false);
    expect(mimeMatches('anything/else', ['*/*'])).toBe(true);
    expect(mimeMatches('text/html', [])).toBe(false);
  });

  it('decodeText honors the charset and falls back to UTF-8', () => {
    expect(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'iso-8859-1')).toBe('café');
    expect(decodeText(Buffer.from('café'), 'no-such-charset')).toBe('café');
  });

  it('parseJsonBody tolerates missing or broken bodies', () => {
    const base = { url: 'u', status: 200, ok: true, contentType: 'application/json', headers: {}, truncated: false };
    expect(parseJsonBody({ ...base, body: Buffer.from('{"a":1}') })).toEqual({ a: 1 });
    expect(parseJsonBody({ ...base, body: Buffer.from('<html>') })).toBeUndefined();
    expect(parseJsonBody(base)).toBeUndefined();
  });
});

// The production transport against an in-process server: proves the connection goes to the pinned
// address (the hostname below does not exist in DNS), and that decompression and the byte cap work.
describe('nodeTransport', () => {
  let server: http.Server;
  let port = 0;
  const big = 'x'.repeat(200_000);

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/gzip') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(Buffer.from(big)));
      } else if (req.url === '/video') {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '1024' });
        res.end(Buffer.alloc(1024));
      } else {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-host-seen': req.headers.host ?? '' });
        res.end('pinned ok');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const request = (path: string, overrides: Partial<TransportRequest> = {}): TransportRequest => ({
    url: new URL(`http://pinned-host.invalid:${port}${path}`),
    addresses: [{ address: '127.0.0.1', family: 4 }],
    headers: { 'accept-encoding': 'gzip' },
    signal: AbortSignal.timeout(5000),
    maxBytes: 1024 * 1024,
    wantBody: () => true,
    ...overrides,
  });

  it('connects to the approved address, keeping the Host header', async () => {
    const response = await nodeTransport(request('/'));
    expect(response.status).toBe(200);
    expect(response.body?.toString()).toBe('pinned ok');
    expect(response.headers['x-host-seen']).toBe(`pinned-host.invalid:${port}`);
  });

  it('decompresses and stops at the byte cap', async () => {
    const response = await nodeTransport(request('/gzip', { maxBytes: 50_000 }));
    expect(response.truncated).toBe(true);
    expect(response.body?.length).toBe(50_000);
    const full = await nodeTransport(request('/gzip'));
    expect(full.truncated).toBe(false);
    expect(full.body?.toString()).toBe(big);
  });

  it('skips bodies the caller does not want', async () => {
    const response = await nodeTransport(request('/video', { wantBody: (_status, type) => type.startsWith('text/') }));
    expect(response.headers['content-type']).toBe('video/mp4');
    expect(response.body).toBeUndefined();
  });

  it('lets the caller judge a body by its headers (the declared length)', async () => {
    const response = await nodeTransport(
      request('/video', { wantBody: (_status, _type, headers) => Number(headers['content-length']) <= 512 }),
    );
    expect(response.headers['content-length']).toBe('1024');
    expect(response.body).toBeUndefined();
  });

  it('fails when no approved address matches', async () => {
    await expect(nodeTransport(request('/', { addresses: [] }))).rejects.toThrow();
  });
});
