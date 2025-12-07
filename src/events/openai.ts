import { Events, type Message } from 'discord.js';
import { AgentOrchestrator } from '../ai/agent';
import { logger } from '../logger';

const agent = new AgentOrchestrator();

module.exports = {
  name: Events.MessageCreate,
  async execute(message: Message) {
    if (message.author.bot) return;

    if (message.mentions.has(message.client.user.id)) {
      const author = message.member?.displayName || message.author.username;
      logger.info(`Bot was mentioned by ${author}, routing to AI agent.`);
      await agent.handleMention(message);
    }
  },
};
