// Posts a one-line "🚀 Deployed <sha>" to the report channel the first time the bot boots on a new
// GIT_SHA (baked into the prod image by CI). Off unless REPORT_CHANNEL_ID + GIT_SHA are both set.
import { Events } from 'discord.js';
import { getMemoryStore } from '../ai/memory';
import { getReportChannelId, sendToReportChannel } from '../ai/reportChannel';
import { formatTimestampET } from '../ai/utils';
import { config } from '../config';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

const STORED_SHA_KEY = 'deploy:last_announced_sha';

/** Announce only when there is a current sha and it differs from the last one we announced. */
export function shouldAnnounce(currentSha: string | undefined, storedSha: string | undefined): boolean {
  return Boolean(currentSha) && currentSha !== storedSha;
}

export default defineEvent(Events.ClientReady, {
  once: true,
  async execute(client) {
    try {
      if (!getReportChannelId() || !config.report.deployAnnounceEnabled) return;

      const currentSha = config.report.gitSha;
      if (!currentSha) return;

      const store = getMemoryStore();
      const storedSha = store.getState(STORED_SHA_KEY);
      if (!shouldAnnounce(currentSha, storedSha)) return;

      const shortSha = currentSha.slice(0, 7);
      await sendToReportChannel(client, `🚀 Deployed \`${shortSha}\` · ${formatTimestampET(new Date())} ET`);
      store.setState(STORED_SHA_KEY, currentSha);
    } catch (error) {
      logger.warn('Deploy announce failed:', error);
    }
  },
});
