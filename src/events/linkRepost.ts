// Rewrites Twitter/X, Instagram, TikTok, Reddit and Bluesky links to embed-fixer domains and reposts
// the message via a webhook so it still looks like the original author sent it. One handler for every
// platform: a message with several links is reposted once, with every fixable link rewritten. Works in
// text, announcement and voice-chat channels, threads and forum posts (through the parent's webhook).
import { Events } from 'discord.js';
import { deletedMessageReposter } from '../deletedMessages';
import { defineEvent } from '../eventModule';
import { fixLinksInContent, hasFixableLink } from '../links/embedFixers';
import { logger } from '../logger';
import { repostBlocker, repostMessage } from '../utils';

export default defineEvent(Events.MessageCreate, {
  async execute(message) {
    if (message.author.bot || message.webhookId) return;
    if (!hasFixableLink(message.content)) return;

    // Cheap checks before any probing: a message that can't be carried over whole is never touched.
    const blocker = repostBlocker(message);
    if (blocker) {
      logger.info(`linkfix: leaving message ${message.id} as-is: ${blocker}`);
      return;
    }

    const original = message.content;
    const result = await fixLinksInContent(original);
    if (result.fixed === 0) {
      logger.warn(`linkfix: no working fixer for the link(s) in message ${message.id}; leaving it as-is`);
      return;
    }
    // discord.js patches the cached message in place on edit: reposting the pre-edit text would undo it.
    if (message.content !== original) {
      logger.info(`linkfix: message ${message.id} was edited while its links were being fixed; leaving it as-is`);
      return;
    }

    const translated = result.translated > 0 ? `, ${result.translated} translated` : '';
    logger.info(`linkfix: rewrote ${result.fixed} link(s)${translated} in message ${message.id}; reposting`);
    try {
      const outcome = await repostMessage(message, result.content, {
        // The bot is about to delete this message itself — that is not the author changing their mind.
        onBeforeDelete: () => deletedMessageReposter.forget(message.id),
        // Downloads and the reply lookup take seconds: an edit landing then must not be undone either.
        stillCurrent: () => message.content === original,
      });
      if (outcome.status !== 'reposted') {
        logger.warn(`linkfix: message ${message.id} not reposted (${outcome.status}): ${outcome.reason}`);
      }
    } catch (error) {
      // Creating the webhook or sending through it failed (Manage Webhooks missing, rate limit, outage).
      // Nothing was deleted: the original stays exactly as posted.
      logger.warn(`linkfix: repost of message ${message.id} failed; the original is untouched:`, error);
    }
  },
});
