// Link enricher: a compact preview of the links in a message (tweet text, video caption, article
// summary, the GIF itself) so the model knows what was shared without spending a tool round.
//
// Discord usually hasn't unfurled a link when MessageCreate fires, and the link fixer deletes the
// original seconds later, so without this the model sees a bare URL. By role:
//   - 'current' / 'reference': read up to 3 links (fetching is free: no model call), one text part each
//     plus up to 2 vetted image parts — within a time budget, so a slow site can't hold the reply
//   - 'history': cached previews only, text only (Discord's own embeds already carry their images)
// Links wrapped in <…> and links inside code are skipped (see findLinks).
import type { Message } from 'discord.js';
import { config } from '../../config';
import type { ContentEnricher, EnrichmentRole } from '../enrichers';
import type { NormalizedContentPart } from '../types';
import { formatLinkPreview } from './format';
import { type LinkReader, getLinkReader } from './reader';
import { findLinks } from './targets';

const MAX_LINKS = 3;
const MAX_IMAGES_PER_LINK = 2;
const MAX_IMAGES_PER_MESSAGE = 4;
// Past this the preview is dropped for this turn; the read keeps going and lands in the cache, where
// read_link (which joins the in-flight read) or the next turn picks it up.
const PREVIEW_BUDGET_MS = 15_000;

/** True when Discord already rendered an image for this link (its embed image is in the message parts). */
function discordShowsImageFor(message: Message, key: string | undefined, reader: LinkReader): boolean {
  if (!key) return false;
  return message.embeds.some((embed) => embed.url && (embed.image || embed.thumbnail) && reader.keyFor(embed.url) === key);
}

function withBudget<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function previewParts(
  message: Message,
  url: string,
  role: EnrichmentRole,
  reader: LinkReader,
): Promise<{ text?: string; images: string[] }> {
  if (role === 'history') {
    const cached = reader.peek(url);
    return cached?.ok ? { text: formatLinkPreview(url, cached), images: [] } : { images: [] };
  }

  const result = await withBudget(reader.read(url), PREVIEW_BUDGET_MS);
  if (!result) return { text: `[link: ${url} — the site is slow; read_link can still open it]`, images: [] };
  if (!result.ok || discordShowsImageFor(message, reader.keyFor(url), reader)) {
    return { text: formatLinkPreview(url, result), images: [] };
  }
  const images = await withBudget(reader.previewImages(result.content, MAX_IMAGES_PER_LINK), PREVIEW_BUDGET_MS);
  return { text: formatLinkPreview(url, result), images: images ?? [] };
}

export function createLinkEnricher(readerFor: () => LinkReader = getLinkReader): ContentEnricher {
  return {
    name: 'links',
    async enrich(message, role) {
      if (!config.linkReader.enabled || !config.linkReader.previewsEnabled) return [];
      const links = findLinks(message.content ?? '').slice(0, MAX_LINKS);
      if (links.length === 0) return [];

      const reader = readerFor();
      const previews = await Promise.all(links.map((url) => previewParts(message, url, role, reader)));

      const parts: NormalizedContentPart[] = [];
      let imageCount = 0;
      for (const preview of previews) {
        if (preview.text) parts.push({ type: 'text', text: preview.text });
        for (const url of preview.images) {
          if (imageCount >= MAX_IMAGES_PER_MESSAGE) break;
          parts.push({ type: 'image', url });
          imageCount++;
        }
      }
      return parts;
    },
  };
}

export const linkEnricher: ContentEnricher = createLinkEnricher();
