// On startup, logs every channel id in the environment as #name, one line per variable (see
// src/channelEnv.ts), so a wrong or deleted channel id is obvious in the logs.
import { Events } from 'discord.js';
import { describeChannelEnvironment, discordChannelLookup } from '../channelEnv';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

export default defineEvent(Events.ClientReady, {
  once: true,
  async execute(client) {
    try {
      const lines = await describeChannelEnvironment(discordChannelLookup(client));
      for (const line of lines) logger.info(`Channel config · ${line}`);
    } catch (error) {
      logger.warn('Could not resolve the channel ids in the environment:', error);
    }
  },
});
