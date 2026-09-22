// Rewrites Twitter/X, Instagram and TikTok links to embed-fixer domains and reposts the message via a
// webhook so it still looks like the original author sent it. One handler for every platform: a
// message with several links is reposted once, with every fixable link rewritten.
import { Events } from 'discord.js';
import { deletedMessageReposter } from '../deletedMessages';
import { defineEvent } from '../eventModule';
import { fixLinksInContent, hasFixableLink } from '../links/embedFixers';
import { logger } from '../logger';
import { isWebhookCapableChannel, repostMessage } from '../utils';

export default defineEvent(Events.MessageCreate, {
  async execute(message) {
    if (message.author.bot || message.webhookId) return;
    if (!isWebhookCapableChannel(message.channel)) return;
    if (!hasFixableLink(message.content)) return;

    const result = await fixLinksInContent(message.content);
    if (result.fixed === 0) {
      logger.warn(`linkfix: no working fixer for the link(s) in message ${message.id}; leaving it as-is`);
      return;
    }

    logger.info(`linkfix: rewrote ${result.fixed} link(s) in message ${message.id}; reposting`);
    // The bot is about to delete this message itself — that is not the author changing their mind.
    deletedMessageReposter.forget(message.id);
    await repostMessage(message, result.content);
  },
});
