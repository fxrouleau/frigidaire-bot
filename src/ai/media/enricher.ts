// Media enricher: turns voice messages / audio / video attachments into model-visible text (transcripts,
// descriptions). Placeholder until the media feature implements it.
import type { ContentEnricher } from '../enrichers';

export const mediaEnricher: ContentEnricher = {
  name: 'media',
  async enrich() {
    return [];
  },
};
