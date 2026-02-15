import { type BaseGuildTextChannel, ChannelType, Events, type Message } from 'discord.js';
import { logger } from '../logger';
import { repostMessage } from '../utils';

export const re = /(https?:\/\/(?:[a-z0-9-]+\.)*?tiktok\.com\/\S+)/;

export const replaceString = (input: string) => {
  return input.replace(re, (match, p1) => {
    const replacedDomain = p1.replace(/tiktok\.com/, 'tnktok.com');
    return match.replace(p1, replacedDomain).replace(/\?.*/, '');
  });
};

module.exports = {
  name: Events.MessageCreate,
  async execute(message: Message) {
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.GuildText) return;

    const tiktokLink = message.content.match(re);
    if (tiktokLink !== null) {
      logger.info(`Found TikTok link in message ${message.id}. Replacing...`);
      const newMessage = message.content.replace(tiktokLink[0], replaceString(tiktokLink[0]));
      await repostMessage(message, newMessage);
    }
  },
};
