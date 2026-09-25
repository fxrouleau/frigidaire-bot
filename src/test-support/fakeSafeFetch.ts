// A scripted SafeFetch for link-reader tests: answers by URL (exact match first, then the longest
// matching prefix) and records every call. Mirrors the real fetch's contract where extractors depend
// on it: a body is only present when the response's content type matches `options.accept`, `url` is
// the post-redirect URL, and `redirect: 'manual'` surfaces `location`.
import type { ExtractorContext } from '../ai/linkReader/extractors/common';
import type { FetchOptions, FetchResult, SafeFetch } from '../ai/linkReader/safeFetch';
import { mimeMatches, parseContentType } from '../ai/linkReader/safeFetch';

export type FakeResponse = {
  status?: number;
  /** Full content-type header; defaults to JSON for object bodies, text/html for strings. */
  contentType?: string;
  body?: string | Buffer | Record<string, unknown> | unknown[];
  headers?: Record<string, string>;
  /** The URL the response came from after redirects (defaults to the requested URL). */
  finalUrl?: string;
  /** Redirect target, returned as `location` (manual) — the fake never follows redirects itself. */
  location?: string;
  truncated?: boolean;
};

export type FakeRoute =
  | FakeResponse
  | Error
  | ((url: string, options: FetchOptions) => FakeResponse | Error | Promise<FakeResponse | Error>);

export type FakeSafeFetch = SafeFetch & { calls: Array<{ url: string; options: FetchOptions }> };

export function createFakeSafeFetch(routes: Record<string, FakeRoute>): FakeSafeFetch {
  const calls: Array<{ url: string; options: FetchOptions }> = [];
  const prefixes = Object.keys(routes).sort((a, b) => b.length - a.length);

  const fetch = (async (input: string | URL, options: FetchOptions): Promise<FetchResult> => {
    const url = input.toString();
    calls.push({ url, options });
    const key = url in routes ? url : prefixes.find((prefix) => url.startsWith(prefix));
    let route: FakeRoute = key !== undefined ? routes[key] : { status: 404, body: '' };
    if (typeof route === 'function') route = await route(url, options);
    if (route instanceof Error) throw route;

    const status = route.status ?? 200;
    const isObject = route.body !== undefined && typeof route.body === 'object' && !Buffer.isBuffer(route.body);
    const contentTypeHeader =
      route.contentType ?? (route.body === undefined ? '' : isObject ? 'application/json' : 'text/html; charset=utf-8');
    const { mime, charset } = parseContentType(contentTypeHeader);
    const bodyBuffer =
      route.body === undefined
        ? undefined
        : Buffer.isBuffer(route.body)
          ? route.body
          : Buffer.from(isObject ? JSON.stringify(route.body) : String(route.body));
    const wantsBody = route.location === undefined && mimeMatches(mime, options.accept);
    const headers: Record<string, string> = {
      ...(contentTypeHeader ? { 'content-type': contentTypeHeader } : {}),
      ...route.headers,
    };
    if (route.location) headers.location = route.location;

    return {
      url: route.finalUrl ?? url,
      status,
      ok: status >= 200 && status < 300,
      contentType: mime,
      charset,
      headers,
      body: wantsBody ? bodyBuffer : undefined,
      truncated: route.truncated ?? false,
      location: options.redirect === 'manual' ? route.location : undefined,
    };
  }) as FakeSafeFetch;
  fetch.calls = calls;
  return fetch;
}

/** Builds a minimal HTML document from meta tags (property or name) plus an optional body. */
export function htmlPage(meta: Record<string, string | string[]>, body = '', head = ''): string {
  const tags = Object.entries(meta)
    .flatMap(([key, values]) => (Array.isArray(values) ? values : [values]).map((value) => [key, value] as const))
    .map(([key, value]) => {
      const attr = key.startsWith('og:') || key.startsWith('article:') ? 'property' : 'name';
      return `<meta ${attr}="${key}" content="${value.replace(/"/g, '&quot;')}">`;
    })
    .join('\n');
  return `<!doctype html><html lang="en"><head>${tags}${head}</head><body>${body}</body></html>`;
}

/** An ExtractorContext over a fake fetch, with an inspectable cooldown set. */
export function fakeExtractorContext(fetch: SafeFetch): ExtractorContext & { cooledDown: Set<string> } {
  const cooledDown = new Set<string>();
  return {
    fetch,
    now: () => 1_000_000,
    isCoolingDown: (key) => cooledDown.has(key),
    coolDown: (key) => {
      cooledDown.add(key);
    },
    cooledDown,
  };
}
