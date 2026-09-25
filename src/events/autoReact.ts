// Spontaneous reactions (src/reactions/): member posts in AUTO_REACT_CHANNELS become candidates, and the
// bot's own replies are noted so a post it is answering never also gets a reaction.
import { Events } from 'discord.js';
import { config } from '../config';
import { defineEvent } from '../eventModule';
import { getAutoReactor } from '../reactions';
import { discordCandidate, intakeSkipReason } from '../reactions/candidate';

export default defineEvent(Events.MessageCreate, {
  execute(message) {
    if (config.autoReact.mode === 'off') return;
    const reactor = getAutoReactor(message.client);
    if (message.author.id === message.client.user.id && !message.webhookId) {
      reactor.noteBotMessage(message.channel.id, {
        repliedToId: message.reference?.messageId,
        partnerId: message.mentions.repliedUser?.id,
      });
      return;
    }
    const skip = intakeSkipReason(message, {
      channelIds: config.autoReact.channelIds,
      botNames: config.gate.names,
    });
    if (skip) return;
    reactor.observe(discordCandidate(message));
  },
});
