import { Events } from 'discord.js';
import { personalityLearner } from '../ai/learnerInstance';
import { defineEvent } from '../eventModule';

export default defineEvent(Events.MessageCreate, {
  execute(message) {
    if (message.author.bot) return;
    if (message.webhookId) return;

    // Cheap bookkeeping only: the learner's capture trigger decides when the channel is read.
    personalityLearner.trackActivity(message.channel.id, {
      at: message.createdTimestamp,
      messageId: message.id,
      authorId: message.author.id,
    });
  },
});
