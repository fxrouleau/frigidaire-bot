// The only way the link reader touches the network.
//
// Global fetch() can't be used here: it resolves DNS itself, after our check, so a hostile DNS server
// could answer "public" to the guard and "10.0.0.5" to the connection (DNS rebinding), and it follows
// redirects without asking. Instead every request goes through node:http/https with a `lookup` hook
// that hands the socket exactly the addresses the guard approved, and redirects are followed here, hop
// by hop, each one re-checked (a public page 302-ing to http://sandbox:8080/ is the obvious attack).
//
// Also enforced here, because every caller needs them: one deadline for the whole request (DNS +
// redirects + body), a byte cap measured AFTER decompression (a gzip bomb stops at the cap), and a
// content-type allowlist so a link to a 2 GB video never has its body downloaded.
import * as http from 'node:http';
import * as https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import { config } from '../../config';
import {
  BlockedUrlError,
  type ResolvedAddress,
  type Resolver,
  checkUrlShape,
  resolvePublicAddresses,
  systemResolver,
} from './netGuard';

export { BlockedUrlError };

export const DISCORD_CRAWLER_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';

const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ---- Transport (the raw HTTP exchange, injectable for tests) ----

export type TransportRequest = {
  url: URL;
  /** The guard-approved addresses; the connection may only go to one of these. */
  addresses: ResolvedAddress[];
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
  /** Decides, from the status line and headers, whether the body is worth downloading at all. */
  wantBody: (status: number, contentType: string) => boolean;
};

export type TransportResponse = {
  status: number;
  /** Lowercased header names; repeated headers joined with ", ". */
  headers: Record<string, string>;
  /** Decoded (decompressed) body, present only when wantBody() said so. */
  body?: Buffer;
  truncated: boolean;
};

export type HttpTransport = (request: TransportRequest) => Promise<TransportResponse>;

function flattenHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

function familyOf(option: number | string | undefined): 0 | 4 | 6 {
  if (option === 4 || option === 'IPv4') return 4;
  if (option === 6 || option === 'IPv6') return 6;
  return 0;
}

/** Production transport: node:http/https pinned to the approved addresses. */
export const nodeTransport: HttpTransport = (request) =>
  new Promise<TransportResponse>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    // Called by net.connect instead of dns.lookup (only for hostnames; IP-literal URLs connect directly
    // to the literal, which the guard already judged). With autoSelectFamily (Node ≥ 20) it asks for
    // `all` addresses and races them, so hand over the whole approved list.
    const lookup: LookupFunction = (_hostname, options, callback) => {
      const family = familyOf(options.family);
      const candidates = family ? request.addresses.filter((a) => a.family === family) : request.addresses;
      if (candidates.length === 0) {
        const error: NodeJS.ErrnoException = new Error('no approved address for this family');
        error.code = 'ENOTFOUND';
        callback(error, '', 0);
        return;
      }
      if (options.all) {
        callback(
          null,
          candidates.map((c) => ({ address: c.address, family: c.family })),
        );
      } else {
        callback(null, candidates[0].address, candidates[0].family);
      }
    };

    const client = request.url.protocol === 'https:' ? https : http;
    const req = client.request(request.url, {
      method: 'GET',
      headers: request.headers,
      lookup,
      signal: request.signal,
      // A fresh connection per request: a pooled socket could have been opened for another host's addresses.
      agent: false,
    });

    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      const headers = flattenHeaders(res.headers);
      if (!request.wantBody(status, headers['content-type'] ?? '')) {
        res.destroy();
        settle(() => resolve({ status, headers, truncated: false }));
        return;
      }

      const encoding = (headers['content-encoding'] ?? '').trim().toLowerCase();
      let decoder: zlib.Unzip | zlib.BrotliDecompress | undefined;
      if (encoding === 'gzip' || encoding === 'x-gzip' || encoding === 'deflate') decoder = zlib.createUnzip();
      else if (encoding === 'br') decoder = zlib.createBrotliDecompress();
      else if (encoding && encoding !== 'identity') {
        res.destroy();
        settle(() => reject(new FetchFailedError(`unsupported content-encoding "${encoding}"`, 'network')));
        return;
      }

      const source: Readable = decoder ? res.pipe(decoder) : res;
      const chunks: Buffer[] = [];
      let size = 0;
      const stop = () => {
        res.destroy();
        decoder?.destroy();
      };

      source.on('data', (chunk: Buffer) => {
        if (settled) return;
        const room = request.maxBytes - size;
        if (chunk.length > room) {
          if (room > 0) chunks.push(chunk.subarray(0, room));
          size = request.maxBytes;
          settle(() => resolve({ status, headers, body: Buffer.concat(chunks), truncated: true }));
          stop();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      source.on('end', () => settle(() => resolve({ status, headers, body: Buffer.concat(chunks), truncated: false })));
      source.on('error', (error) => settle(() => reject(error)));
      if (decoder) res.on('error', (error) => settle(() => reject(error)));
      res.on('close', () => {
        if (!res.complete) settle(() => reject(new Error('connection closed before the response completed')));
      });
    });
    req.on('error', (error) => settle(() => reject(error)));
    req.end();
  });

// ---- The guarded fetch ----

export class FetchFailedError extends Error {
  constructor(
    message: string,
    readonly reason: 'timeout' | 'network' | 'redirects',
  ) {
    super(message);
    this.name = 'FetchFailedError';
  }
}

export type FetchOptions = {
  /** MIME patterns whose bodies are downloaded ('text/html', 'image/*', …). Other responses come back bodiless. */
  accept: string[];
  userAgent?: string;
  headers?: Record<string, string>;
  maxBytes?: number;
  /** Deadline for the whole request, redirects and body included. */
  timeoutMs?: number;
  /** 'manual' returns the first redirect (with `location`) instead of following it. */
  redirect?: 'follow' | 'manual';
  maxRedirects?: number;
};

export type FetchResult = {
  /** The URL that produced this response (after redirects). */
  url: string;
  status: number;
  ok: boolean;
  /** Lowercased MIME type without parameters ('' when absent). */
  contentType: string;
  charset?: string;
  headers: Record<string, string>;
  body?: Buffer;
  truncated: boolean;
  /** Absolute redirect target, for redirect: 'manual'. */
  location?: string;
};

export type SafeFetch = (url: string | URL, options: FetchOptions) => Promise<FetchResult>;

export function parseContentType(header: string | undefined): { mime: string; charset?: string } {
  if (!header) return { mime: '' };
  const [mimePart, ...params] = header.split(';');
  const charset = params
    .map((p) => p.trim())
    .find((p) => p.toLowerCase().startsWith('charset='))
    ?.slice('charset='.length)
    .replace(/^["']|["']$/g, '')
    .trim();
  return { mime: mimePart.trim().toLowerCase(), charset: charset || undefined };
}

export function mimeMatches(mime: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p === '*/*') return true;
    if (p.endsWith('/*')) return mime.startsWith(p.slice(0, -1));
    if (p.startsWith('*+')) return mime.endsWith(p.slice(1));
    return mime === p;
  });
}

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function describeNetworkError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code) return `network error (${code})`;
  return error instanceof Error ? `network error (${error.message})` : 'network error';
}

export type SafeFetchDeps = { resolver?: Resolver; transport?: HttpTransport };

export function createSafeFetch(deps: SafeFetchDeps = {}): SafeFetch {
  const resolver = deps.resolver ?? systemResolver;
  const transport = deps.transport ?? nodeTransport;

  return async (input, options) => {
    const timeoutMs = options.timeoutMs ?? config.linkReader.timeoutMs;
    const maxBytes = options.maxBytes ?? config.linkReader.maxPageBytes;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const signal = AbortSignal.timeout(timeoutMs);
    const headers: Record<string, string> = {
      'user-agent': options.userAgent ?? DISCORD_CRAWLER_UA,
      accept: options.accept.join(', '),
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      ...options.headers,
    };

    let url = checkUrlShape(input);
    for (let hop = 0; ; hop++) {
      let response: TransportResponse;
      try {
        const addresses = await withSignal(resolvePublicAddresses(url, resolver), signal);
        response = await transport({
          url,
          addresses,
          headers,
          signal,
          maxBytes,
          wantBody: (status, contentType) =>
            !REDIRECT_STATUSES.has(status) && mimeMatches(parseContentType(contentType).mime, options.accept),
        });
      } catch (error) {
        if (error instanceof BlockedUrlError || error instanceof FetchFailedError) throw error;
        if (signal.aborted) throw new FetchFailedError(`timed out after ${timeoutMs} ms`, 'timeout');
        throw new FetchFailedError(describeNetworkError(error), 'network');
      }

      const { mime, charset } = parseContentType(response.headers['content-type']);
      const result: FetchResult = {
        url: url.toString(),
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        contentType: mime,
        charset,
        headers: response.headers,
        body: response.body,
        truncated: response.truncated,
      };

      const locationHeader = REDIRECT_STATUSES.has(response.status) ? response.headers.location : undefined;
      if (!locationHeader) return result;

      let target: URL;
      try {
        target = new URL(locationHeader, url);
      } catch {
        throw new FetchFailedError(`invalid redirect target "${locationHeader.slice(0, 200)}"`, 'network');
      }
      if (options.redirect === 'manual') return { ...result, location: target.toString() };
      if (hop >= maxRedirects) throw new FetchFailedError(`more than ${maxRedirects} redirects`, 'redirects');
      // Every hop is judged from scratch: shape here, DNS at the top of the loop.
      url = checkUrlShape(target);
    }
  };
}

/** The body as text, honoring the declared charset (falls back to UTF-8 for unknown labels). */
export function decodeText(body: Buffer, charset?: string): string {
  const label = charset?.toLowerCase();
  if (label && label !== 'utf-8' && label !== 'utf8') {
    try {
      return new TextDecoder(label).decode(body);
    } catch {
      // Unknown label: UTF-8 below is the best guess.
    }
  }
  return new TextDecoder('utf-8').decode(body);
}

/** Parses a JSON body; undefined when there is no body or it isn't JSON. */
export function parseJsonBody(result: FetchResult): unknown {
  if (!result.body) return undefined;
  try {
    return JSON.parse(decodeText(result.body, result.charset));
  } catch {
    return undefined;
  }
}
