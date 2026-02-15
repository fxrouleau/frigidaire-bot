import { type BaseGuildTextChannel, ChannelType, Events, type Message } from 'discord.js';
import { logger } from '../logger';
import { repostMessage } from '../utils';

export const re = /(https?:\/\/(?:[a-z0-9-]+\.)?(twitter|x)\.com\/[\w]+\/status\/\S+)/;

export const replaceString = (input: string) => {
  return input.replace(re, (match, p1) => {
    const replacedDomain = p1.replace(/(twitter\.com|x\.com)/, 'fixvx.com');
    return match.replace(p1, replacedDomain).replace(/\?.*/, '');
  });
};

module.exports = {
  name: Events.MessageCreate,
  async execute(message: Message) {
    // Quick sanity checks
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.GuildText) return;

    // Check if the message contains a Twitter link
    const twitterLink = message.content.match(re);
    if (twitterLink !== null) {
      logger.info(`Found twitter link in message ${message.id}. Replacing...`);
      const newMessage = message.content.replace(twitterLink[0], replaceString(twitterLink[0]));
      await repostMessage(message, newMessage);
    }
  },
};
