// Counts custom-emoji reactions toward each emoji's use_count.
//
// Partial-safe (see src/discordClient.ts): a reaction on a message sent before the last restart arrives
// as a partial reaction on a partial message, but the emoji id comes straight from the gateway event,
// so it is always there. The reacting user is only partial when discord.js has never seen them (guild
// reaction adds normally carry the member); then it is fetched once to learn whether it is a bot.
import { Events, type PartialUser, type User } from 'discord.js';
import { getMemoryStore } from '../ai/memory';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

/** Whether the reactor is a bot, fetching a partial user first; undefined when that cannot be known. */
async function isBotUser(user: User | PartialUser): Promise<boolean | undefined> {
  if (!user.partial) return user.bot;
  try {
    return (await user.fetch()).bot;
  } catch (error) {
    logger.warn(`reactionTracker: could not fetch partial user ${user.id}:`, error);
    return undefined;
  }
}

export default defineEvent(Events.MessageReactionAdd, {
  async execute(reaction, user) {
    const emojiId = reaction.emoji.id;
    if (!emojiId) return; // standard Unicode emoji — only track custom ones

    // Unknown ⇒ skip: a missed count is harmless, counting the bot's own reactions is not.
    if ((await isBotUser(user)) !== false) return;

    try {
      getMemoryStore().incrementEmojiUsage(emojiId);
    } catch (error) {
      logger.warn(`reactionTracker: increment failed for ${emojiId}:`, error);
    }
  },
});
