import { Events, type Message, ChannelType, type BaseGuildTextChannel } from "discord.js";

const re = /(https?:\/\/(twitter|x)\.com\/.+\/status\/\S+)/;

const replaceString = (input: string) => {
  return input.replace(re, (match, p1) => {
    const replacedDomain = p1.replace(/(twitter\.com|x\.com)/, "fixvx.com");
    return match.replace(p1, replacedDomain).replace(/\?.*/, "");
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
      // Create the hook
      const webhook = await (message.channel as BaseGuildTextChannel).createWebhook({
        name: message.member?.nickname || message.author.displayName,
        avatar: message.member?.displayAvatarURL({ forceStatic: true }),
      });
      const newMessage = message.content.replace(twitterLink[0], replaceString(twitterLink[0]));
      await Promise.all([
        message.delete(),
        webhook.send(newMessage)
      ]);
      // Cleanup the webhook, we don't need it anymore; they're one-time use
      await webhook.delete();
    }
  },
};
