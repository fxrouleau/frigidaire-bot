import { type Client, Events } from 'discord.js';
import { logger } from '../logger';

module.exports = {
  name: Events.ClientReady,
  once: true,
  execute(client: Client) {
    logger.info(`Ready! Logged in as ${client.user?.tag}`);
  },
};
