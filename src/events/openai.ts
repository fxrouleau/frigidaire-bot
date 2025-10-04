import { Events, type Message } from 'discord.js';
import OpenAI from 'openai';

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
      const chunk = await message.channel.messages.fetch({ limit: 100, before: lastIdBeforeChunk });
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

    await message.channel.sendTyping();
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
          .map((msg) => {
            const authorName = msg.member?.displayName || msg.author.displayName;
            return {
              role: msg.author.id === message.client.user.id ? 'assistant' : 'user',
              content: `${authorName}: ${msg.content}`,
            };
          });

        conversationHistory[channelId] = {
          timestamp: now,
          history: [
            {
              role: 'system',
              content: `You are a helpful assistant in a Discord channel. Your primary function is to chat. If the user asks to summarize messages, use the 'summarize_messages' tool. Otherwise, respond as a standard chatbot. The current time is ${new Date().toISOString()}`,
            },
            ...historicalContext,
          ],
        };
      }

      // Add the new user message to the history
      const currentAuthorName = message.member?.displayName || message.author.displayName;
      conversationHistory[channelId].history.push({
        role: 'user',
        content: `${currentAuthorName}: ${message.content}`,
      });
      conversationHistory[channelId].timestamp = now;

      try {
        await message.channel.sendTyping();

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
            const functionName = toolCall.function.name;
            if (functionName === 'summarize_messages') {
              let functionArgs: { start_time: string; end_time: string };
              try {
                functionArgs = JSON.parse(toolCall.function.arguments);
              } catch (e) {
                console.error('Failed to parse tool arguments:', e);
                await message.reply(
                  'I received invalid parameters from the model and could not proceed. Please try again.',
                );
                continue; // Skip to the next tool call
              }

              const summary = await summarize_messages(message, functionArgs.start_time, functionArgs.end_time);

              // Add the tool's response to the history
              conversationHistory[channelId].history.push({
                tool_call_id: toolCall.id,
                role: 'tool',
                content: summary,
              });
            }
          }

          // Second API call to get a natural language response based on the tool's output
          const finalCompletion = await openai.chat.completions.create({
            model: 'gpt-5-mini',
            messages: conversationHistory[channelId].history,
          });

          const finalResponse = finalCompletion.choices[0].message.content;
          if (finalResponse) {
            conversationHistory[channelId].history.push({ role: 'assistant', content: finalResponse });
            await message.reply(finalResponse);
          }
        } else {
          // If the model decides to chat directly
          const responseContent = responseMessage.content;
          if (responseContent) {
            conversationHistory[channelId].history.push({ role: 'assistant', content: responseContent });
            await message.reply(responseContent);
          }
        }
      } catch (error) {
        console.error('Error in OpenAI interaction:', error);
        await message.reply('Sorry, I encountered an error while processing your request.');
      }
    }
  },
};
