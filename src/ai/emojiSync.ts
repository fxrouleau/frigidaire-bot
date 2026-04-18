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
