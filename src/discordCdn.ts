// Signing Discord CDN links to message attachments. Those links carry a signature (the ex/is/hm query
// parameters) and expire after about a day, and the CDN answers 404 to anyone but Discord's own clients for
// a link without a valid one. A link someone pastes into a message is usually unsigned or long expired: a
// GIF favorited from Discord's picker is posted as exactly that, a bare cdn.discordapp.com/attachments/…
// link (Discord's client re-signs it to show it). A bot signs such links the same way, through
// POST /attachments/refresh-urls: up to 50 links per call, answered with a fresh signed link for each one
// whose attachment still exists. The route is what Discord's clients use; it is missing from Discord's
// official docs (the community documents it at docs.discord.food, "Cloud uploads") and from discord.js's
// route table, so it is called by path. It signs whatever it is sent, so both what goes in and what comes
// back are checked to be Discord attachment links.
import type { REST } from 'discord.js';
import { logger } from './logger';

const ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const ATTACHMENT_PATH = /^\/(?:ephemeral-)?attachments\/\d+\/\d+\/[^/]+$/;
const SIGNATURE_PARAMS = ['ex', 'is', 'hm'] as const;
/** The route's limit per call. */
const MAX_URLS_PER_CALL = 50;
const REFRESH_TIMEOUT_MS = 5_000;
/** A signed link this close to expiring is signed again: the download that follows takes a while. */
const EXPIRY_MARGIN_MS = 60_000;

/** Signs attachment links: original → signed, for the ones it could sign (the rest are left out). */
export type UrlSigner = (urls: string[]) => Promise<Map<string, string>>;

function parse(url: string | URL): URL | undefined {
  if (url instanceof URL) return url;
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** A link to a message attachment on Discord's CDN (or its media proxy), signed or not. */
export function isDiscordAttachmentUrl(url: string | URL): boolean {
  const parsed = parse(url);
  return (
    parsed !== undefined &&
    parsed.protocol === 'https:' &&
    ATTACHMENT_HOSTS.has(parsed.hostname.toLowerCase()) &&
    ATTACHMENT_PATH.test(parsed.pathname)
  );
}

function isSigned(url: URL): boolean {
  return SIGNATURE_PARAMS.every((param) => url.searchParams.get(param));
}

/**
 * Whether an attachment link has to be signed before the CDN serves it: it has no signature, or one that
 * expired or expires within a minute (`ex` is the expiry in hex epoch seconds). False for anything that
 * isn't an attachment link.
 */
export function needsSigning(url: string | URL, now = Date.now()): boolean {
  const parsed = parse(url);
  if (!parsed || !isDiscordAttachmentUrl(parsed)) return false;
  if (!isSigned(parsed)) return true;
  const expires = Number.parseInt(parsed.searchParams.get('ex') ?? '', 16) * 1000;
  return !Number.isFinite(expires) || expires - now < EXPIRY_MARGIN_MS;
}

type RefreshResponse = { refreshed_urls?: Array<{ original?: unknown; refreshed?: unknown }> };

/**
 * A signer over the bot's REST client. It never throws: a failed call is logged and its links come back
 * unsigned (left out of the map). Only attachment links are sent, and only a signed attachment link for the
 * same file is accepted back.
 */
export function createAttachmentUrlSigner(rest: Pick<REST, 'post'>): UrlSigner {
  return async (urls) => {
    const signed = new Map<string, string>();
    const wanted = [...new Set(urls)].filter((url) => isDiscordAttachmentUrl(url));
    for (let start = 0; start < wanted.length; start += MAX_URLS_PER_CALL) {
      const batch = wanted.slice(start, start + MAX_URLS_PER_CALL);
      let response: RefreshResponse;
      try {
        response = (await rest.post('/attachments/refresh-urls', {
          body: { attachment_urls: batch },
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        })) as RefreshResponse;
      } catch (error) {
        logger.warn(`discordCdn: signing ${batch.length} attachment link(s) failed:`, error);
        continue;
      }
      // Matched back by the link sent (Discord echoes it), else by the file's path: an echo that dropped a
      // parameter or swapped the host must not leave the GIF unseen.
      const byPath = new Map<string, string[]>();
      for (const url of batch) {
        const path = parse(url)?.pathname ?? '';
        byPath.set(path, [...(byPath.get(path) ?? []), url]);
      }
      for (const entry of response?.refreshed_urls ?? []) {
        if (typeof entry?.original !== 'string' || typeof entry.refreshed !== 'string') continue;
        const refreshed = parse(entry.refreshed);
        if (!refreshed || !isDiscordAttachmentUrl(refreshed) || !isSigned(refreshed)) continue;
        const samePath = byPath.get(refreshed.pathname) ?? [];
        const sent = batch.includes(entry.original) ? [entry.original] : samePath;
        for (const url of sent) {
          if (parse(url)?.pathname === refreshed.pathname) signed.set(url, refreshed.toString());
        }
      }
    }
    return signed;
  };
}
