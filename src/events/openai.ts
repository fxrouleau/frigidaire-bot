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

      // Initialize conversation history if it doesn't exist
      if (!conversationHistory[channelId] || now - conversationHistory[channelId].timestamp > CONVERSATION_TIMEOUT) {
        conversationHistory[channelId] = {
          timestamp: now,
          history: [
            {
              role: 'system',
              content: 'You are a helpful assistant.',
            },
          ],
        };
      }

      // Add user message to history
      conversationHistory[channelId].history.push({
        role: 'user',
        content: message.content,
      });
      conversationHistory[channelId].timestamp = now;

      try {
        await message.channel.sendTyping();
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
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
