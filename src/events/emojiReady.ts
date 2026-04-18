import { type Client, Events } from 'discord.js';
import { reconcileGuildEmojis } from '../ai/emojiSync';
import { logger } from '../logger';

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client: Client) {
    const guilds = [...client.guilds.cache.values()];
    logger.info(`emojiReady: reconciling emojis across ${guilds.length} guild(s)`);
    for (const guild of guilds) {
      try {
        const emojis = await guild.emojis.fetch();
        await reconcileGuildEmojis(guild.id, new Map(emojis.map((e) => [e.id, e])));
      } catch (error) {
        logger.warn(`emojiReady: failed to reconcile guild ${guild.id}:`, error);
      }
    }
  },
};
