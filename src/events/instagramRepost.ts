import { type BaseGuildTextChannel, ChannelType, Events, type Message } from 'discord.js';
import { logger } from '../logger';
import { repostMessage } from '../utils';

const re = /(https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/\S+)/;

const replaceString = (input: string) => {
  return input.replace(re, (match, p1) => {
    const replacedDomain = p1.replace(/instagram\.com/, 'ddinstagram.com');
    return match.replace(p1, replacedDomain).replace(/\?.*/, '');
  });
};

module.exports = {
  name: Events.MessageCreate,
  async execute(message: Message) {
    // Quick sanity checks
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.GuildText) return;

    // Check if the message contains an Instagram link
    const instagramLink = message.content.match(re);
    if (instagramLink !== null) {
      logger.info(`Found instagram link in message ${message.id}. Replacing...`);
      const newMessage = message.content.replace(instagramLink[0], replaceString(instagramLink[0]));
      await repostMessage(message, newMessage);
    }
  },
};
