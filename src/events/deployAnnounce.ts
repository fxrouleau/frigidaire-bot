// Posts "🚀 Deployed <sha>" to the report channel the first time the bot boots on a new GIT_SHA (baked
// into the prod image by CI), followed by the channel configuration resolved to #names (the same lines
// the startup log gets, see src/channelEnv.ts) so a wrong channel id is caught on the deploy that
// introduced it. Off unless REPORT_CHANNEL_ID + GIT_SHA are both set.
import { type Client, Events } from 'discord.js';
import { getMemoryStore } from '../ai/memory';
import { getReportChannelId, sendToReportChannel } from '../ai/reportChannel';
import { formatTimestampET } from '../ai/utils';
import { describeChannelEnvironment, discordChannelLookup } from '../channelEnv';
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
      const headline = `🚀 Deployed \`${shortSha}\` · ${formatTimestampET(new Date())} ET`;
      await sendToReportChannel(client, formatAnnouncement(headline, await channelBlock(client)));
      store.setState(STORED_SHA_KEY, currentSha);
    } catch (error) {
      logger.warn('Deploy announce failed:', error);
    }
  },
});

/** The headline, then the channel lines in a code block (monospace, and env names stay literal). */
export function formatAnnouncement(headline: string, channelLines: string[]): string {
  if (channelLines.length === 0) return headline;
  return `${headline}\n\`\`\`\n${channelLines.join('\n')}\n\`\`\``;
}

/** The channel configuration lines; empty (announce without them) if resolving fails. */
async function channelBlock(client: Client): Promise<string[]> {
  try {
    return await describeChannelEnvironment(discordChannelLookup(client));
  } catch (error) {
    logger.warn('Deploy announce: could not resolve the channel configuration:', error);
    return [];
  }
}
