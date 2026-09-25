import { Events, type Message } from 'discord.js';
import type { HandleMentionOptions } from '../ai/agent';
import { agent } from '../ai/agentInstance';
import { isTranscriptReply, isTranscriptReplyId } from '../ai/media/autoTranscribe';
import { defineEvent } from '../eventModule';
import { addressedGate } from '../gate';
import { logger } from '../logger';

async function isReplyToBot(message: Message): Promise<boolean> {
  const referencedId = message.reference?.messageId;
  if (!referencedId) return false;
  // The bot's auto-transcript of a voice message isn't the bot talking: a reply to it answers the voice message.
  if (isTranscriptReplyId(referencedId)) return false;
  const botId = message.client.user.id;
  // Discord resolves the replied-to author (ping or not), which rules out replies to anyone else without
  // a REST fetch for every reply posted server-wide.
  const repliedUser = message.mentions.repliedUser;
  if (repliedUser && repliedUser.id !== botId) return false;
  // A reply to the bot: Discord ships the replied-to message along and discord.js caches it, so telling a
  // transcript the bot has no record of (by its header) from a real reply normally costs nothing.
  const cached = message.channel.messages.cache?.get(referencedId);
  if (cached?.author) return cached.author.id === botId && !isTranscriptReply(cached);
  if (repliedUser) return true;
  try {
    const repliedTo = await message.channel.messages.fetch(referencedId);
    return repliedTo.author.id === botId && !isTranscriptReply(repliedTo);
  } catch {
    return false;
  }
}

/**
 * The bot's id typed into the message. Discord also lists the replied-to author among the mentions when
 * a reply pings, so `mentions.users` alone would make every pinged reply to the bot (a voice-message
 * transcript included) an explicit mention; replies are isReplyToBot()'s call.
 */
function mentionsBot(message: Message): boolean {
  const botId = message.client.user.id;
  if (!message.mentions.users.has(botId)) return false;
  if (message.mentions.repliedUser?.id !== botId) return true;
  return (message.content ?? '').includes(`<@${botId}>`) || (message.content ?? '').includes(`<@!${botId}>`);
}

/** Runs one agent turn; the gate learns when it ends (see AddressedGate.noteTurnDone). */
async function routeToAgent(message: Message, opts?: HandleMentionOptions): Promise<void> {
  try {
    // An explicit mention/reply is the agent's default turn: called exactly as before the gate existed.
    await (opts ? agent.handleMention(message, opts) : agent.handleMention(message));
  } finally {
    addressedGate.noteTurnDone(message);
  }
}

export default defineEvent(Events.MessageCreate, {
  async execute(message) {
    // The bot's own messages tell the gate when it last spoke per channel (who it is talking to comes from
    // routed turns, see AddressedGate.noteRouted/noteTurnDone).
    if (message.author.id === message.client.user.id && !message.webhookId) {
      // A voice-message transcript is not the bot speaking in the conversation.
      if (!isTranscriptReply(message)) addressedGate.noteBotMessage(message);
      return;
    }
    if (message.author.bot) return;

    const author = message.member?.displayName || message.author.username;
    const explicitMention = mentionsBot(message);
    const replyToBot = await isReplyToBot(message);

    if (explicitMention || replyToBot) {
      logger.info(`Bot was ${replyToBot ? 'replied to' : 'mentioned'} by ${author}, routing to AI agent.`);
      addressedGate.noteRouted(message);
      await routeToAgent(message);
      return;
    }

    // No mention and no reply: the gate decides whether the message is still meant for the bot.
    const verdict = await addressedGate.evaluate(message);
    if (verdict.respond) {
      logger.info(
        `Bot was addressed without a mention by ${author} (${verdict.trigger}${verdict.cold ? ', cold' : ''}), routing to AI agent.`,
      );
      // Unprompted: the agent tells the model nobody pinged it, so it doesn't answer "you pinged me?".
      await routeToAgent(message, { unprompted: true });
    }
  },
});
