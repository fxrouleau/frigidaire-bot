// Images for the auto-react judge (a post's picture is often the whole joke) and for memory capture. Only
// Discord-hosted URLs are fetched (attachments on the CDN, embed images through Discord's media proxy), so
// nothing here reaches an arbitrary host. Each image is downscaled and inlined as a data URI: the model only
// needs the gist, image tokens are most of the cost of a call, and a raw URL would make OpenRouter fetch it
// itself, which Discord's proxy refuses now and then (the whole request then fails with a 400).
import sharp from 'sharp';
import { logger } from '../logger';

const DISCORD_MEDIA_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
// Discord's proxy for external embed images (images-ext-1.discordapp.net, …).
const DISCORD_EXTERNAL_PROXY = /^images-ext-\d+\.discordapp\.net$/;

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 768;
const TIMEOUT_MS = 8000;

type FetchLike = (url: string, init?: { signal?: AbortSignal; redirect?: RequestRedirect }) => Promise<Response>;

export function isDiscordMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (DISCORD_MEDIA_HOSTS.has(parsed.hostname) || DISCORD_EXTERNAL_PROXY.test(parsed.hostname))
    );
  } catch {
    return false;
  }
}

/** One image as a downscaled JPEG data URI, or undefined (not Discord-hosted, too big, not an image, failed). */
export async function loadImageDataUri(
  url: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<string | undefined> {
  if (!isDiscordMediaUrl(url)) return undefined;
  try {
    // A redirect could lead off Discord's hosts (anything else goes through the guarded fetch): refused.
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    if (!response.ok) {
      logger.debug(`images: fetch failed (HTTP ${response.status})`);
      return undefined;
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) return undefined;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) return undefined;
    // First frame of a GIF/APNG/WebP animation; flattened so transparency doesn't turn black.
    const jpeg = await sharp(buffer)
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80 })
      .toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  } catch (error) {
    logger.debug('images: could not load an image:', error);
    return undefined;
  }
}

/** Loads up to `max` of the URLs (in order), in parallel; failures are simply left out. */
export async function loadImages(urls: string[], max: number, fetchImpl?: FetchLike): Promise<string[]> {
  const unique = [...new Set(urls)].slice(0, max);
  const loaded = await Promise.all(unique.map((url) => loadImageDataUri(url, fetchImpl)));
  return loaded.filter((uri): uri is string => uri !== undefined);
}
