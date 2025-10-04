import { type Collection, Events, type Message } from 'discord.js';
import OpenAI from 'openai';
import { logger } from '../logger';
import { splitMessage } from '../utils';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Defines the tools the model can use
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'summarize_messages',
      description:
        "Summarize the messages in the channel within a given timeframe. The user's current time is an ISO 8601 string. The maximum timeframe to summarize is one week.",
      parameters: {
        type: 'object',
        properties: {
          start_time: {
            type: 'string',
            format: 'date-time',
            description:
              'The start of the time range for the summary, in ISO 8601 format. E.g., "2025-10-03T03:00:00Z".',
          },
          end_time: {
            type: 'string',
            format: 'date-time',
            description:
              'The end of the time range for the summary, in ISO 8601 format. If the user asks for "today", this should be the current time.',
          },
        },
        required: ['start_time', 'end_time'],
      },
    },
  },
];

// Shared conversation history
const conversationHistory: {
  [key: string]: { timestamp: number; history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] };
} = {};
const CONVERSATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/**
 * Sanitize a string to be a valid OpenAI `name` property.
 * The `name` property can contain a-z, A-Z, 0-9, and underscores, with a maximum length of 64 characters.
 * @param name The name to sanitize.
 * @returns The sanitized name.
 */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 64);
}

/**
 * Fetches messages within a given time range and returns a summary.
 */
async function summarize_messages(message: Message, startTime: string, endTime: string): Promise<string> {
  try {
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return 'Invalid date format. Please use ISO 8601 format (e.g., "2025-10-03T18:00:00Z").';
    }
    if (endDate.getTime() - startDate.getTime() > 7 * 24 * 60 * 60 * 1000) {
      return 'The maximum timeframe for a summary is one week.';
    }
    if (startDate > endDate) {
      return 'The start time must be before the end time.';
    }

    const messagesForSummary: Message[] = [];
    let lastIdBeforeChunk: string | undefined = undefined;

    // Fetch messages in chunks of 100, going backwards in time.
    // We'll fetch a max of 50 chunks (5000 messages) as a safeguard.
    for (let i = 0; i < 50; i++) {
      const chunk: Collection<string, Message> = await message.channel.messages.fetch({
        limit: 100,
        before: lastIdBeforeChunk,
      });
      if (chunk.size === 0) break;

      lastIdBeforeChunk = chunk.lastKey();
      const oldestMessageInChunk = chunk.last();

      for (const msg of chunk.values()) {
        if (msg.createdAt >= startDate && msg.createdAt <= endDate) {
          if (!msg.author.bot) {
            messagesForSummary.push(msg);
          }
        }
      }

      if (oldestMessageInChunk && oldestMessageInChunk.createdAt < startDate) {
        break; // Stop fetching if we've gone past the start date
      }
    }

    if (messagesForSummary.length === 0) {
      return 'I found no messages in that time range to summarize.';
    }

    // Reverse to get chronological order and format for the prompt
    const formattedMessages = messagesForSummary
      .reverse()
      .map((msg) => `${msg.member?.displayName || msg.author.username}: ${msg.content}`)
      .join('\n');

    const summaryPrompt = `Please provide a concise summary of the key topics and events from the following Discord chat conversation:\n\n---\n${formattedMessages}\n---`;

    if (message.channel.isTextBased() && 'sendTyping' in message.channel) {
      await message.channel.sendTyping();
    }
    const summaryCompletion = await openai.chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: 'You are an expert at summarizing conversations.' },
        { role: 'user', content: summaryPrompt },
      ],
    });

    return summaryCompletion.choices[0].message.content || 'I was unable to generate a summary.';
  } catch (error) {
    console.error('Error in summarize_messages:', error);
    return 'An error occurred while trying to summarize the messages.';
  }
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message: Message) {
    if (message.author.bot) return;

    // Check if the bot is mentioned
    if (message.mentions.has(message.client.user.id)) {
      const author = message.member?.displayName || message.author.username;
      logger.info(`Bot was mentioned by ${author}, processing...`);
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
        const recentMessages = await message.channel.messages.fetch({ limit: 10, before: message.id });
        const historicalContext: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [...recentMessages.values()]
          .reverse()
          .filter((msg) => !msg.author.bot || msg.author.id === message.client.user.id)
          .map((msg): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
            const authorName = msg.member?.displayName || msg.author.displayName;
            const isAssistant = msg.author.id === message.client.user.id;
            return {
              role: isAssistant ? 'assistant' : 'user',
              content: msg.content,
              ...(isAssistant ? {} : { name: sanitizeName(authorName) }),
            };
          });

        const botName = message.client.user.displayName;
        conversationHistory[channelId] = {
          timestamp: now,
          history: [
            {
              role: 'system',
              content: `You are ${botName}, a helpful assistant in a Discord channel. Your primary function is to chat. Be conversational and concise. Do not offer multiple versions of an answer (e.g., "Straight:", "Casual:"). Provide a single, direct response. ONLY use the 'summarize_messages' tool if the user explicitly asks for a summary. For all other questions, respond directly as a standard chatbot. The current time is ${new Date().toISOString()}`,
            },
            ...historicalContext,
          ],
        };
      }

      // Add the new user message to the history
      const currentAuthorName = message.member?.displayName || message.author.displayName;
      conversationHistory[channelId].history.push({
        role: 'user',
        content: message.content,
        name: sanitizeName(currentAuthorName),
      });
      conversationHistory[channelId].timestamp = now;

      try {
        if (message.channel.isTextBased() && 'sendTyping' in message.channel) {
          await message.channel.sendTyping();
        }

        // First API call to determine intent (chat vs. tool)
        const completion = await openai.chat.completions.create({
          model: 'gpt-5-mini',
          messages: conversationHistory[channelId].history,
          tools: tools,
          tool_choice: 'auto',
        });

        const responseMessage = completion.choices[0].message;
        const toolCalls = responseMessage.tool_calls;

        // If the model wants to call a tool
        if (toolCalls) {
          conversationHistory[channelId].history.push(responseMessage); // Add assistant's tool call message

          for (const toolCall of toolCalls) {
            let toolResponse: string;
            if (toolCall.type !== 'function') continue;

            const functionName = toolCall.function.name;
            const author = message.member?.displayName || message.author.username;
            logger.info(`Tool ${functionName} called by ${author}.`);

            switch (functionName) {
              case 'summarize_messages': {
                try {
                  const args = JSON.parse(toolCall.function.arguments);
                  toolResponse = await summarize_messages(message, args.start_time, args.end_time);
                } catch (e) {
                  logger.error('Failed to parse arguments for summarize_messages:', e);
                  toolResponse = 'Invalid arguments provided for summarization.';
                }
                break;
              }
              default:
                logger.warn(`Unknown tool called: ${functionName}`);
                toolResponse = `Unknown tool: ${functionName}`;
            }

            // Add the tool's response to the history for every tool call
            conversationHistory[channelId].history.push({
              tool_call_id: toolCall.id,
              role: 'tool',
              content: toolResponse,
            });
          }

          // Second API call to get a natural language response based on the tool's output
          logger.info('Sending tool results to OpenAI for final response.');
          const finalCompletion = await openai.chat.completions.create({
            model: 'gpt-5-mini',
            messages: conversationHistory[channelId].history,
          });

          const finalResponse = finalCompletion.choices[0].message.content;
          if (finalResponse) {
            conversationHistory[channelId].history.push({ role: 'assistant', content: finalResponse });
            const chunks = splitMessage(finalResponse);
            for (const chunk of chunks) {
              await message.reply(chunk);
            }
          } else {
            logger.warn('OpenAI returned a null message content after tool call.');
            await message.reply("I've processed the information, but I don't have anything further to add.");
          }
        } else {
          // If the model decides to chat directly
          const responseContent = responseMessage.content;
          const author = message.member?.displayName || message.author.username;
          if (responseContent) {
            logger.info(`Sending conversational response to ${author}.`);
            conversationHistory[channelId].history.push({ role: 'assistant', content: responseContent });
            const chunks = splitMessage(responseContent);
            for (const chunk of chunks) {
              await message.reply(chunk);
            }
          } else {
            logger.warn('OpenAI returned a null message content for a direct chat.');
            await message.reply("I'm not sure how to respond to that.");
          }
        }
      } catch (error) {
        console.error('Error in OpenAI interaction:', error);
        await message.reply('Sorry, I encountered an error while processing your request.');
      }
    }
  },
};
