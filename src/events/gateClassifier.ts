import * as process from 'node:process';
import { Events, type Message } from 'discord.js';
import { agent } from '../ai/agentInstance';
import { classifyMessage } from '../ai/gateClassifier';
import { logger } from '../logger';

module.exports = {
  name: Events.MessageCreate,
  async execute(message: Message) {
    if (!process.env.OPENROUTER_API_KEY) return;
    if (message.author.bot) return;
    if (message.mentions.users.has(message.client.user.id)) return;
    if (!message.content.trim()) return;

    // Direct replies to the bot are handled explicitly by aiChat.ts
    if (message.reference?.messageId) {
      try {
        const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
        if (repliedTo.author.id === message.client.user.id) return;
      } catch {
        // Couldn't fetch referenced message, continue to classifier
      }
    }

    const result = await classifyMessage(message);
    if (result.shouldRespond) {
      const author = message.member?.displayName || message.author.username;
      logger.info(`Gate classifier triggered for ${author}: ${result.reason}`);
      await agent.handleMention(message);
    }
  },
};
