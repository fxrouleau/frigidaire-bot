import { Events, type Message } from 'discord.js';
import { personalityLearner } from '../ai/learnerInstance';

module.exports = {
  name: Events.MessageCreate,
  execute(message: Message) {
    if (message.author.bot) return;
    if (message.webhookId) return;

    // Zero-cost Set.add; the learner batches these every LEARNING_INTERVAL_MS.
    personalityLearner.trackActivity(message.channel.id);
  },
};
