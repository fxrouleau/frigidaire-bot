// Startup sync for the message archive: fill the gap left by downtime, then import older history for
// ARCHIVE_BACKFILL_CHANNELS (resumable across restarts). A periodic maintenance tick resolves relay
// kinds, picks up new voice transcripts and resumes an unfinished import.
import { Events } from 'discord.js';
import { getArchiveStore } from '../archive/archiveStore';
import { ArchiveSync, discordSyncDeps, setActiveArchiveSync } from '../archive/backfill';
import { config } from '../config';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

export default defineEvent(Events.ClientReady, {
  once: true,
  execute(client) {
    if (!config.archive.enabled) return;

    try {
      const store = getArchiveStore();
      const mb = (store.sizeBytes() / 1024 / 1024).toFixed(1);
      logger.info(`archive: ${store.countMessages().toLocaleString('en-US')} message(s) archived (${mb} MB).`);
    } catch (error) {
      logger.error('archive: cannot open the archive database; no history sync this run:', error);
      return;
    }

    const sync = new ArchiveSync(discordSyncDeps(client));
    setActiveArchiveSync(sync);

    if (config.archive.backfillEnabled) {
      const channels = config.archive.backfillChannels;
      logger.info(
        `archive: syncing (gap fill${channels.length > 0 ? `, then history import for ${channels.length} channel(s)` : ''}).`,
      );
      void sync.run().catch((error) => logger.warn('archive: sync failed:', error));
    }
    setInterval(() => sync.maintenance(), MAINTENANCE_INTERVAL_MS).unref();
  },
});
