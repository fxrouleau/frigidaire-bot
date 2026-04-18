import * as process from 'node:process';
import { type Client, Events } from 'discord.js';
import { reconcileGuildEmojis } from '../ai/emojiSync';
import { getMemoryStore } from '../ai/tools';
import { logger } from '../logger';

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client: Client) {
    // One-shot re-caption flag: set EMOJI_FORCE_RECAPTION=true (e.g., after swapping
    // the captioner model) to null every caption before reconciliation re-fills them.
    // Unset the env var again before the next restart.
    if (process.env.EMOJI_FORCE_RECAPTION === 'true') {
      const cleared = getMemoryStore().clearAllEmojiCaptions();
      logger.warn(`emojiReady: EMOJI_FORCE_RECAPTION=true — cleared ${cleared} emoji caption(s) for re-captioning`);
    }

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
