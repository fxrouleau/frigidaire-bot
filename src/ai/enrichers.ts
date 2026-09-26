// Content enrichers add model-visible content derived from a Discord message beyond its raw text and
// images: voice-message transcripts, link previews, video descriptions. The chat agent runs every
// enricher over each user message it renders.
//
// Each enricher decides how much work a message deserves from its role:
//   - 'current'   the message that triggered this turn — may do paid work (transcribe, fetch a link)
//   - 'reference' the message it replies to (and that message's reply chain) — may do paid work
//   - 'history'   seeded or intervening channel history — caches only, never new paid work
import type { Message } from 'discord.js';
import { logger } from '../logger';
import { linkEnricher } from './linkReader/enricher';
import { mediaEnricher } from './media/enricher';
import type { NormalizedContentPart } from './types';

export type EnrichmentRole = 'current' | 'reference' | 'history';

export type ContentEnricher = {
  name: string;
  enrich(message: Message, role: EnrichmentRole): Promise<NormalizedContentPart[]>;
};

export const defaultEnrichers: ContentEnricher[] = [mediaEnricher, linkEnricher];

// A slow enricher must never hold a reply hostage: past this, its contribution is dropped for the turn.
const ENRICHER_TIMEOUT_MS = 60_000;

/** Runs every enricher concurrently; a failing or timed-out enricher contributes nothing. */
export async function runEnrichers(
  message: Message,
  role: EnrichmentRole,
  enrichers: ContentEnricher[] = defaultEnrichers,
): Promise<NormalizedContentPart[]> {
  if (enrichers.length === 0) return [];
  const results = await Promise.all(
    enrichers.map(async (enricher) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<NormalizedContentPart[]>((resolve) => {
          timer = setTimeout(() => {
            logger.warn(`enricher ${enricher.name} timed out on message ${message.id}`);
            resolve([]);
          }, ENRICHER_TIMEOUT_MS);
        });
        return await Promise.race([enricher.enrich(message, role), timeout]);
      } catch (error) {
        logger.warn(`enricher ${enricher.name} failed on message ${message.id}:`, error);
        return [];
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
  return results.flat();
}
