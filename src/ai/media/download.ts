// Bounded media downloads. Voice messages and uploaded clips come from Discord's CDN, but video URLs
// also arrive from shared links (the link reader) and image URLs from embeds, so only Discord's own
// media hosts are fetched directly; every other URL goes through the link reader's SSRF-guarded fetch
// (createSafeFetch: DNS checked and the connection pinned to the checked addresses, every redirect hop
// re-judged, a content-type allowlist so a surprise HTML page is never downloaded).
//
// Both paths enforce a hard byte cap while streaming — a missing or lying Content-Length can't make the
// bot buffer a 2 GB file — and one timeout covering the whole transfer.
import { config } from '../../config';
import { logger } from '../../logger';
import { BlockedUrlError, FetchFailedError, type SafeFetch, createSafeFetch } from '../linkReader/safeFetch';

export type DownloadResult =
  | { ok: true; data: Buffer; contentType?: string }
  | { ok: false; reason: 'blocked' | 'too_large' | 'http' | 'network' };

export type DownloadOptions = {
  maxBytes: number;
  timeoutMs: number;
  /** Transport for Discord's own media hosts (default: global fetch). */
  fetch?: typeof globalThis.fetch;
  /** The guarded fetch for every other host (default: the shared createSafeFetch() instance). */
  safeFetch?: SafeFetch;
  /** MIME patterns accepted from non-Discord hosts (default: audio, video and generic binary). */
  accept?: string[];
};

const MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (compatible; FrigidaireBot/1.0; +https://discord.com)';
// Object stores and CDNs behind shared links regularly label media generically.
export const MEDIA_ACCEPT = [
  'audio/*',
  'video/*',
  'application/octet-stream',
  'binary/octet-stream',
  'application/mp4',
  'application/ogg',
];

let sharedSafeFetch: SafeFetch | undefined;

// Under Vitest the default guarded fetch can't reach the network (tests inject their own), like the
// link reader's shared instance.
const offlineSafeFetch: SafeFetch = async () => {
  throw new FetchFailedError('network access is disabled in tests', 'network');
};

function defaultSafeFetch(): SafeFetch {
  sharedSafeFetch ??= config.isTest ? offlineSafeFetch : createSafeFetch();
  return sharedSafeFetch;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/**
 * True for URLs the bot may fetch on a member's behalf (the shape check the direct path applies on every
 * hop; the guarded path applies the link reader's stricter rules). The WHATWG parser already normalizes
 * numeric host tricks (`https://2130706433/` becomes 127.0.0.1), so the IPv4 check sees the real address.
 */
export function isFetchableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || host.includes(':')) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  if (!host.includes('.')) return false;
  return !isPrivateIpv4(host);
}

/**
 * Discord's own media hosts — the attachment CDN (cdn.discordapp.com, media.discordapp.net) and the
 * external-media proxy (images-ext-N.discordapp.net) — over https: the only URLs fetched directly.
 */
export function isDiscordMediaUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return host === 'cdn.discordapp.com' || host === 'media.discordapp.net' || host.endsWith('.discordapp.net');
  } catch {
    return false;
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer | undefined> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/** Downloads `url` into memory, refusing anything over `maxBytes`. Never throws. */
export async function downloadMedia(url: string, opts: DownloadOptions): Promise<DownloadResult> {
  if (!isDiscordMediaUrl(url)) return downloadGuarded(url, opts);

  const fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let current = url;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isFetchableUrl(current)) {
        logger.warn(`media: refusing to fetch ${redact(current)}`);
        return { ok: false, reason: 'blocked' };
      }
      const response = await fetchImpl(current, {
        redirect: 'manual',
        signal,
        headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      });

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => undefined);
        current = new URL(location, current).toString();
        // Discord sending us elsewhere: from here on it's an arbitrary URL, so it gets the guarded fetch.
        if (!isDiscordMediaUrl(current)) return downloadGuarded(current, opts);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        logger.warn(`media: download of ${redact(current)} failed with HTTP ${response.status}`);
        return { ok: false, reason: 'http' };
      }

      const declared = Number(response.headers.get('content-length') ?? Number.NaN);
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      const data = await readCapped(response, opts.maxBytes);
      if (!data) return { ok: false, reason: 'too_large' };
      return { ok: true, data, contentType: response.headers.get('content-type') ?? undefined };
    }
    logger.warn(`media: too many redirects for ${redact(url)}`);
    return { ok: false, reason: 'http' };
  } catch (error) {
    logger.warn(`media: download of ${redact(current)} failed:`, error);
    return { ok: false, reason: 'network' };
  }
}

/** A non-Discord URL, through the link reader's SSRF-guarded fetch. */
async function downloadGuarded(url: string, opts: DownloadOptions): Promise<DownloadResult> {
  const safeFetch = opts.safeFetch ?? defaultSafeFetch();
  try {
    const result = await safeFetch(url, {
      accept: opts.accept ?? MEDIA_ACCEPT,
      maxBytes: opts.maxBytes,
      timeoutMs: opts.timeoutMs,
    });
    if (!result.ok) {
      logger.warn(`media: download of ${redact(result.url)} failed with HTTP ${result.status}`);
      return { ok: false, reason: 'http' };
    }
    if (!result.body) {
      // The content-type allowlist said no (an HTML error page, a login wall): nothing was downloaded.
      logger.warn(`media: ${redact(result.url)} is ${result.contentType || 'untyped'}, not media; skipping`);
      return { ok: false, reason: 'http' };
    }
    const declared = Number(result.headers['content-length']);
    if (result.truncated || (Number.isFinite(declared) && declared > opts.maxBytes)) {
      return { ok: false, reason: 'too_large' };
    }
    return { ok: true, data: result.body, contentType: result.contentType || undefined };
  } catch (error) {
    if (error instanceof BlockedUrlError) {
      logger.warn(`media: refusing to fetch ${redact(url)} (${error.message})`);
      return { ok: false, reason: 'blocked' };
    }
    logger.warn(`media: download of ${redact(url)} failed:`, error instanceof Error ? error.message : error);
    return { ok: false, reason: 'network' };
  }
}

/** Logs the URL without its query: Discord CDN links carry signing parameters. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(invalid url)';
  }
}
