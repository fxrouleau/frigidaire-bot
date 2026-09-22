import { Events, type Message } from 'discord.js';
import { agent } from '../ai/agentInstance';
import { defineEvent } from '../eventModule';
import { logger } from '../logger';

async function isReplyToBot(message: Message): Promise<boolean> {
  if (!message.reference?.messageId) return false;
  // Discord resolves the replied-to author into the mentions when the reply pings them, which
  // answers the question without a REST fetch for every reply posted server-wide.
  const repliedUser = message.mentions.repliedUser;
  if (repliedUser) return repliedUser.id === message.client.user.id;
  try {
    const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
    return repliedTo.author.id === message.client.user.id;
  } catch {
    return false;
  }
}

export default defineEvent(Events.MessageCreate, {
  async execute(message) {
    if (message.author.bot) return;

    const explicitMention = message.mentions.users.has(message.client.user.id);
    const replyToBot = await isReplyToBot(message);

    if (explicitMention || replyToBot) {
      const author = message.member?.displayName || message.author.username;
      logger.info(`Bot was ${replyToBot ? 'replied to' : 'mentioned'} by ${author}, routing to AI agent.`);
      await agent.handleMention(message);
    }
  },
});
