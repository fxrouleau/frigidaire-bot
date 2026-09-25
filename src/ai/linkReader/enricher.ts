// Link enricher: adds a compact preview of links in a message (tweet text, video description, article
// summary) so the model knows what was shared. Placeholder until the link reader implements it.
import type { ContentEnricher } from '../enrichers';

export const linkEnricher: ContentEnricher = {
  name: 'links',
  async enrich() {
    return [];
  },
};
