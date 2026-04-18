import type { GuildEmoji } from 'discord.js';
import { logger } from '../logger';
import { captionEmoji } from './emojiCaptioner';
import { getMemoryStore } from './tools';

/**
 * Insert/update an emoji in the DB and caption it if no caption exists yet or the
 * name (and thus likely meaning) changed. Safe to call repeatedly.
 */
export async function syncEmoji(emoji: GuildEmoji): Promise<void> {
  if (!emoji.id || !emoji.name) return;

  const store = getMemoryStore();
  const { inserted, nameChanged } = store.upsertEmoji({
    id: emoji.id,
    name: emoji.name,
    animated: Boolean(emoji.animated),
  });

  const existing = store.getEmojiById(emoji.id);
  const needsCaption = inserted || nameChanged || !existing?.caption;
  if (!needsCaption) return;

  const caption = await captionEmoji({
    id: emoji.id,
    name: emoji.name,
    animated: Boolean(emoji.animated),
  });

  if (caption) {
    store.setEmojiCaption(emoji.id, caption);
    logger.info(`emojiSync: captioned ${emoji.name} (${emoji.id}) → "${caption}"`);
  }
}

/**
 * Reconcile the DB with the current guild emoji list. Called on ready and when
 * GuildEmojiDelete fires. Tombstones any emoji in the DB that the guild no longer
 * has, and syncs every currently present one.
 */
export async function reconcileGuildEmojis(guildId: string, liveEmojis: Map<string, GuildEmoji>): Promise<void> {
  const store = getMemoryStore();
  const liveIds = new Set<string>();
  for (const emoji of liveEmojis.values()) {
    if (emoji.id) liveIds.add(emoji.id);
  }

  for (const stored of store.getUsableEmojis()) {
    if (!liveIds.has(stored.id)) {
      store.deactivateEmoji(stored.id);
      logger.info(`emojiSync: deactivated removed emoji ${stored.name} (${stored.id})`);
    }
  }

  for (const emoji of liveEmojis.values()) {
    try {
      await syncEmoji(emoji);
    } catch (error) {
      logger.warn(`emojiSync: failed to sync emoji in guild ${guildId}:`, error);
    }
  }
}
