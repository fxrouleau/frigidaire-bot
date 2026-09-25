// Bounded media downloads. Voice messages and uploaded clips come from Discord's CDN, but video URLs
// also arrive from shared links (the link reader), so every URL is treated as untrusted: https only,
// no private or loopback hosts (re-checked on each redirect hop), a hard byte cap enforced while
// streaming — a missing or lying Content-Length can't make the bot buffer a 2 GB file — and one
// timeout covering the whole transfer.
import { logger } from '../../logger';

export type DownloadResult =
  | { ok: true; data: Buffer; contentType?: string }
  | { ok: false; reason: 'blocked' | 'too_large' | 'http' | 'network' };

export type DownloadOptions = {
  maxBytes: number;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
};

const MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (compatible; FrigidaireBot/1.0; +https://discord.com)';

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
 * True for URLs the bot may fetch on a member's behalf. The WHATWG parser already normalizes numeric
 * host tricks (`https://2130706433/` becomes 127.0.0.1), so the IPv4 check sees the real address. IPv6
 * literals are refused outright; public media hosts are never addressed that way. (A public name that
 * resolves to a private address is out of scope: the bot's network has nothing worth reaching that way.)
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

/** Logs the URL without its query: Discord CDN links carry signing parameters. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(invalid url)';
  }
}
