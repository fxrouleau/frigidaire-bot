// Gate classifier - responds to messages that naturally address the bot without explicit @mentions.
// Requires OPENROUTER_API_KEY. Explicit mentions/replies are handled by aiChat.ts.

import * as process from 'node:process';
import { Events, type Message } from 'discord.js';
import { agent } from '../ai/agentInstance';
import { classifyMessage } from '../ai/gateClassifier';
// import { personalityLearner } from '../ai/learnerInstance';
import { logger } from '../logger';

module.exports = {
  name: Events.MessageCreate,
  async execute(message: Message) {
    if (!process.env.OPENROUTER_API_KEY) return;
    if (message.author.bot) return;

    // Track channel activity for personality learner (zero cost — just Set.add)
    // personalityLearner.trackActivity(message.channel.id);

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

    // Check if the bot has an active conversation in this channel (within 5-min timeout)
    const hasActiveConversation = agent.hasActiveConversation(message.channel.id);

    const result = await classifyMessage(message, { hasActiveConversation });
    if (result.shouldRespond) {
      const author = message.member?.displayName || message.author.username;
      logger.info(`Gate classifier triggered for ${author}: ${result.reason}`);
      await agent.handleMention(message);
    }
  },
};
