import { Events } from 'discord.js';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

export default defineEvent(Events.ClientReady, {
  once: true,
  execute(client) {
    logger.info(`Ready! Logged in as ${client.user.tag}`);
  },
});
