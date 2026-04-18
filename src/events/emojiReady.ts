import * as process from 'node:process';
import { type Client, Events, type GuildEmoji } from 'discord.js';
import { syncEmoji } from '../ai/emojiSync';
import { getMemoryStore } from '../ai/tools';
import { logger } from '../logger';

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client: Client) {
    // Env diagnostic so we can tell why re-captioning didn't fire. Logs only presence
    // of secret-ish values (no OPENROUTER_API_KEY content); flag vars are logged raw.
    const rawForce = process.env.EMOJI_FORCE_RECAPTION;
    logger.info(
      `emojiReady: env — EMOJI_FORCE_RECAPTION=${JSON.stringify(rawForce)} EMOJI_CAPTION_MODEL=${JSON.stringify(process.env.EMOJI_CAPTION_MODEL)} OPENROUTER_API_KEY=${process.env.OPENROUTER_API_KEY ? 'set' : 'MISSING'}`,
    );

    // One-shot re-caption flag: set EMOJI_FORCE_RECAPTION=true (e.g., after swapping
    // the captioner model) to null every caption before reconciliation re-fills them.
    // Accept a few lenient truthy spellings so stray whitespace/quotes don't silently
    // turn it off.
    const normalizedForce = (rawForce ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .toLowerCase();
    if (normalizedForce === 'true' || normalizedForce === '1' || normalizedForce === 'yes') {
      const cleared = getMemoryStore().clearAllEmojiCaptions();
      logger.warn(
        `emojiReady: EMOJI_FORCE_RECAPTION=${rawForce} — cleared ${cleared} emoji caption(s) for re-captioning`,
      );
    }

    const guilds = [...client.guilds.cache.values()];
    logger.info(`emojiReady: collecting emojis across ${guilds.length} guild(s)`);

    // Aggregate live emojis across ALL guilds first. If we deactivated per-guild we'd
    // nuke every emoji that isn't in whichever guild we're currently processing.
    const liveIds = new Set<string>();
    const liveEmojis: GuildEmoji[] = [];
    for (const guild of guilds) {
      try {
        const emojis = await guild.emojis.fetch();
        logger.info(`emojiReady: guild ${guild.name} (${guild.id}) → ${emojis.size} emoji(s)`);
        for (const emoji of emojis.values()) {
          if (!emoji.id) continue;
          liveIds.add(emoji.id);
          liveEmojis.push(emoji);
        }
      } catch (error) {
        logger.warn(`emojiReady: failed to fetch emojis for guild ${guild.id}:`, error);
      }
    }

    // Safety rail: if we got zero live emojis across every guild, don't touch the DB.
    // Could be a transient Discord API blip or a permissions issue — nuking the store
    // would mean re-captioning everything on the next startup for no reason.
    if (liveIds.size === 0) {
      logger.warn('emojiReady: zero live emojis aggregated — skipping deactivation to avoid nuking the DB');
      return;
    }

    const store = getMemoryStore();
    let deactivated = 0;
    for (const stored of store.getUsableEmojis()) {
      if (!liveIds.has(stored.id)) {
        store.deactivateEmoji(stored.id);
        logger.info(`emojiReady: deactivated removed emoji ${stored.name} (${stored.id})`);
        deactivated++;
      }
    }

    let captioned = 0;
    for (const emoji of liveEmojis) {
      try {
        const before = store.getEmojiById(emoji.id);
        await syncEmoji(emoji);
        const after = store.getEmojiById(emoji.id);
        if (!before?.caption && after?.caption) captioned++;
      } catch (error) {
        logger.warn(`emojiReady: syncEmoji failed for ${emoji.name} (${emoji.id}):`, error);
      }
    }

    logger.info(`emojiReady: done — live=${liveIds.size} deactivated=${deactivated} captioned=${captioned}`);
  },
};
