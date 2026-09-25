import { Events, type Message } from 'discord.js';
import type { HandleMentionOptions } from '../ai/agent';
import { agent } from '../ai/agentInstance';
import { isTranscriptReply, repliesToTranscript } from '../ai/media/autoTranscribe';
import { defineEvent } from '../eventModule';
import { addressedGate } from '../gate';
import { logger } from '../logger';

/**
 * The bot is @-mentioned in the text. Not `mentions.users`: Discord also lists there the author a reply
 * pinged (a reply's default), and whether a reply is meant for the bot is isReplyToBot()'s call.
 */
function mentionsBot(message: Message): boolean {
  return message.mentions.parsedUsers.has(message.client.user.id);
}

async function isReplyToBot(message: Message): Promise<boolean> {
  if (!message.reference?.messageId) return false;
  // The bot's auto-transcript of a voice message isn't the bot talking: a reply to it answers the voice message.
  if (repliesToTranscript(message)) return false;
  // discord.js resolves the replied-to author whenever the replied-to message still exists, which
  // answers the question without a REST fetch for every reply posted server-wide.
  const repliedUser = message.mentions.repliedUser;
  if (repliedUser) return repliedUser.id === message.client.user.id;
  try {
    const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
    return repliedTo.author.id === message.client.user.id && !isTranscriptReply(repliedTo);
  } catch {
    return false;
  }
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
