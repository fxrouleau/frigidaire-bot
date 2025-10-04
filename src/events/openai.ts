import { Events, type Message } from 'discord.js';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Shared conversation history
const conversationHistory: {
  [key: string]: { timestamp: number; history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] };
} = {};
const CONVERSATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

module.exports = {
  name: Events.MessageCreate,
  async execute(message: Message) {
    if (message.author.bot) return;

    // Check if the bot is mentioned
    if (message.mentions.has(message.client.user.id)) {
      const channelId = message.channel.id;
      const now = Date.now();

      // Clean up expired conversation histories
      for (const id in conversationHistory) {
        if (now - conversationHistory[id].timestamp > CONVERSATION_TIMEOUT) {
          delete conversationHistory[id];
        }
      }

      // Initialize conversation history if it doesn't exist or has expired
      if (!conversationHistory[channelId] || now - conversationHistory[channelId].timestamp > CONVERSATION_TIMEOUT) {
        // Fetch the last 10 messages to build context
        const recentMessages = await message.channel.messages.fetch({ limit: 10, before: message.id });
        const historicalContext: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

        // Reverse the messages to get them in chronological order (oldest first)
        const sortedMessages = [...recentMessages.values()].reverse();

        for (const msg of sortedMessages) {
          // Ignore messages from other bots, but keep our own
          if (msg.author.bot && msg.author.id !== message.client.user.id) continue;

          const authorName = msg.member?.displayName || msg.author.displayName;
          historicalContext.push({
            role: msg.author.id === message.client.user.id ? 'assistant' : 'user',
            content: `${authorName}: ${msg.content}`,
          });
        }

        conversationHistory[channelId] = {
          timestamp: now,
          history: [
            {
              role: 'system',
              content:
                "You are a helpful assistant in a Discord channel. The following is the recent message history. Each message is prefixed with the user's display name. Use this context to inform your response.",
            },
            ...historicalContext,
          ],
        };
      }

      // Add user message to history
      const currentAuthorName = message.member?.displayName || message.author.displayName;
      conversationHistory[channelId].history.push({
        role: 'user',
        content: `${currentAuthorName}: ${message.content}`,
      });
      conversationHistory[channelId].timestamp = now;

      try {
        await message.channel.sendTyping();
        const completion = await openai.chat.completions.create({
          model: 'gpt-5-mini',
          messages: conversationHistory[channelId].history,
        });

        if (completion.choices[0].message.content) {
          const response = completion.choices[0].message.content;
          // Add assistant response to history
          conversationHistory[channelId].history.push({
            role: 'assistant',
            content: response,
          });
          await message.reply(response);
        }
      } catch (error) {
        console.error('Error calling OpenAI:', error);
        await message.reply('Sorry, I encountered an error.');
      }
    }
  },
};
