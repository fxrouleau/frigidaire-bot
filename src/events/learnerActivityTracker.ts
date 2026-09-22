import { Events } from 'discord.js';
import { personalityLearner } from '../ai/learnerInstance';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.MessageCreate, {
  execute(message) {
    if (message.author.bot) return;
    if (message.webhookId) return;

    // Zero-cost Set.add; the learner batches these every LEARNING_INTERVAL_MS.
    personalityLearner.trackActivity(message.channel.id);
  },
});
