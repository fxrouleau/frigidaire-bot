import { AttachmentBuilder, type Collection, Events, type Message } from 'discord.js';
import OpenAI from 'openai';
import { logger } from '../logger';
import { splitMessage } from '../utils';

type MessageContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'low' | 'high' | 'auto' };

type ConversationMessage = {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | MessageContentPart[];
};

type FunctionToolDefinition = {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

type ResponseToolDefinition = FunctionToolDefinition | { type: 'web_search' };

type ResponseOutputContent = { type: string; text?: string };

type ResponseOutputItem = {
  type: string;
  role?: string;
  content?: ResponseOutputContent[];
};

type ToolCall = {
  id: string;
  type: string;
  function?: {
    name: string;
    arguments: string;
  };
};

type ResponseLike = {
  id: string;
  status?: string;
  output_text?: string | null;
  output?: ResponseOutputItem[];
  required_action?: {
    type?: string;
    submit_tool_outputs?: {
      tool_calls: ToolCall[];
    };
  };
};

type ToolOutput = {
  tool_call_id: string;
  output: string;
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type ResponseCreateParams = Parameters<(typeof openai)['responses']['create']>[0];

// Defines the tools the model can use
const tools: ResponseToolDefinition[] = [
  {
    type: 'function',
    name: 'summarize_messages',
    description:
      "Summarize the messages in the channel within a given timeframe. The user's current time is an ISO 8601 string. The maximum timeframe to summarize is one week.",
    parameters: {
      type: 'object',
      properties: {
        start_time: {
          type: 'string',
          format: 'date-time',
          description: 'The start of the time range for the summary, in ISO 8601 format. E.g., "2025-10-03T03:00:00Z".',
        },
        end_time: {
          type: 'string',
          format: 'date-time',
          description:
            'The end of the time range for the summary, in ISO 8601 format. If the user asks for "today", this should be the current time.',
        },
      },
      required: ['start_time', 'end_time'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'generate_image',
    description: 'Generate an image based on a user-provided prompt using DALL-E 3.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'A detailed description of the image to generate.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  { type: 'web_search' },
];

// Shared conversation history
type ConversationState = {
  timestamp: number;
  responseId: string | null;
};

const conversationState: Record<string, ConversationState> = {};
const CONVERSATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

function buildSystemInstructions(botName: string): string {
  return `You are ${botName}, a helpful assistant in a Discord channel. Be conversational, concise, and friendly. You can see and process images. Use the summarize_messages tool only when the user explicitly asks for a summary. Use the generate_image tool only when the user asks to create or generate an image. Use the web_search tool when the user asks for up-to-date information or when you need external knowledge beyond your training data. For all other situations, respond directly without calling tools. The current time is ${new Date().toISOString()}.`;
}

function buildUserContentParts(msg: Message): MessageContentPart[] {
  const content: MessageContentPart[] = [];
  const text = msg.content.trim();
  if (text.length > 0) {
    content.push({ type: 'input_text', text });
  }

  if (msg.attachments.size > 0) {
    for (const attachment of msg.attachments.values()) {
      if (attachment.contentType?.startsWith('image/')) {
        content.push({ type: 'input_image', image_url: attachment.url, detail: 'auto' });
      }
    }
  }

  return content;
}

function toConversationMessage(msg: Message, botId: string): ConversationMessage | null {
  if (msg.author.bot && msg.author.id !== botId) {
    return null;
  }

  if (msg.author.id === botId) {
    return {
      role: 'assistant',
      content: msg.content,
    };
  }

  const userContent = buildUserContentParts(msg);
  if (userContent.length === 0) {
    return null;
  }
  return {
    role: 'user',
    content: userContent,
  };
}

function extractResponseText(response: ResponseLike): string | undefined {
  if (typeof response.output_text === 'string' && response.output_text.trim().length > 0) {
    return response.output_text;
  }

  const assistantMessage = response.output?.find((item) => item.type === 'message' && item.role === 'assistant');
  if (!assistantMessage || !assistantMessage.content) {
    return undefined;
  }

  const textParts = assistantMessage.content
    .filter((contentPart) => typeof contentPart.text === 'string' && contentPart.text.trim().length > 0)
    .map((contentPart) => contentPart.text?.trim() ?? '');

  const combined = textParts.join('\n');
  return combined.length > 0 ? combined : undefined;
}

async function submitToolOutputs(responseId: string, toolOutputs: ToolOutput[]): Promise<ResponseLike> {
  const client: { _client: { post: (path: string, args: unknown) => Promise<unknown> } } =
    openai.responses as unknown as { _client: { post: (path: string, args: unknown) => Promise<unknown> } };

  const rawResponse = (await client._client.post(`/responses/${responseId}/submit_tool_outputs`, {
    body: { tool_outputs: toolOutputs },
  })) as ResponseLike;

  return rawResponse;
}

async function resolveToolCalls(initialResponse: ResponseLike, message: Message): Promise<ResponseLike> {
  let response = initialResponse;

  while (
    response.status === 'requires_action' &&
    response.required_action?.type === 'submit_tool_outputs' &&
    response.required_action.submit_tool_outputs
  ) {
    const toolCalls = response.required_action.submit_tool_outputs.tool_calls ?? [];
    const toolOutputs: ToolOutput[] = [];

    for (const toolCall of toolCalls) {
      if (toolCall.type !== 'function' || !toolCall.function) {
        logger.warn('Received unsupported tool call from OpenAI.');
        continue;
      }

      const { name, arguments: rawArgs } = toolCall.function;
      const author = message.member?.displayName || message.author.username;
      logger.info(`Tool ${name} called by ${author}.`);

      let toolResponse = '';

      try {
        switch (name) {
          case 'summarize_messages': {
            const args = JSON.parse(rawArgs ?? '{}');
            toolResponse = await summarize_messages(message, args.start_time, args.end_time);
            break;
          }
          case 'generate_image': {
            const args = JSON.parse(rawArgs ?? '{}');
            toolResponse = await generate_image(message, args.prompt);
            break;
          }
          default:
            logger.warn(`Unknown tool called: ${name}`);
            toolResponse = `Unknown tool: ${name}`;
        }
      } catch (error) {
        logger.error(`Error executing tool ${name}:`, error);
        toolResponse = `An error occurred while executing the ${name} tool.`;
      }

      toolOutputs.push({
        tool_call_id: toolCall.id,
        output: toolResponse,
      });
    }

    if (toolOutputs.length === 0) {
      logger.warn('No tool outputs were generated; aborting tool resolution loop.');
      break;
    }

    response = await submitToolOutputs(response.id, toolOutputs);
  }

  return response;
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
    const summaryResponse = (await openai.responses.create({
      model: 'gpt-5-mini',
      input: [
        { role: 'system', content: 'You are an expert at summarizing conversations.' },
        { role: 'user', content: summaryPrompt },
      ],
      store: false,
    })) as ResponseLike;

    return extractResponseText(summaryResponse) ?? 'I was unable to generate a summary.';
  } catch (error) {
    console.error('Error in summarize_messages:', error);
    return 'An error occurred while trying to summarize the messages.';
  }
}

/**
 * Generates an image using DALL-E 3 and sends it to the channel.
 */
async function generate_image(message: Message, prompt: string): Promise<string> {
  logger.info(`Image generation requested with prompt: "${prompt}"`);
  if (message.channel.isTextBased() && 'sendTyping' in message.channel) {
    await message.channel.sendTyping();
  }

  try {
    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt: prompt,
      n: 1,
      size: '1024x1024',
    });

    const imageUrl = response.data?.[0]?.url;
    if (imageUrl) {
      const attachment = new AttachmentBuilder(imageUrl).setName('image.png');
      await message.reply({
        content: 'Here is the image you requested.',
        files: [attachment],
      });
      return 'The image was generated successfully and sent to the user.';
    }
    return 'I was unable to generate an image for that prompt.';
  } catch (error) {
    logger.error('Error in generate_image:', error);
    return 'An error occurred while generating the image. This may be due to a content policy violation or other issue.';
  }
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message: Message) {
    if (message.author.bot) return;

    if (!message.mentions.has(message.client.user.id)) {
      return;
    }

    const author = message.member?.displayName || message.author.username;
    logger.info(`Bot was mentioned by ${author}, processing...`);

    const channelId = message.channel.id;
    const now = Date.now();

    for (const id in conversationState) {
      if (now - conversationState[id].timestamp > CONVERSATION_TIMEOUT) {
        delete conversationState[id];
      }
    }

    const existingState = conversationState[channelId];
    const isStateValid = existingState?.responseId && now - existingState.timestamp <= CONVERSATION_TIMEOUT;
    const previousResponseId = isStateValid ? (existingState?.responseId ?? undefined) : undefined;

    const userContentParts = buildUserContentParts(message);
    if (userContentParts.length === 0) {
      await message.reply("I didn't find any text or supported attachments to process.");
      return;
    }

    const currentUserMessage: ConversationMessage = {
      role: 'user',
      content: userContentParts,
    };

    let inputMessages: ConversationMessage[] = [];

    if (previousResponseId) {
      inputMessages = [currentUserMessage];
    } else {
      const recentMessages = await message.channel.messages.fetch({ limit: 10, before: message.id });
      const contextMessages = [...recentMessages.values()]
        .reverse()
        .map((msg) => toConversationMessage(msg, message.client.user.id))
        .filter((msg): msg is ConversationMessage => msg !== null);

      inputMessages = [...contextMessages, currentUserMessage];
    }

    try {
      if (message.channel.isTextBased() && 'sendTyping' in message.channel) {
        await message.channel.sendTyping();
      }

      const botName = message.client.user.displayName;

      const requestPayload: Record<string, unknown> = {
        model: 'gpt-5-mini',
        instructions: buildSystemInstructions(botName),
        input: inputMessages,
        tools,
        store: true,
      };

      if (previousResponseId) {
        requestPayload.previous_response_id = previousResponseId;
      }

      let response = (await openai.responses.create(requestPayload as ResponseCreateParams)) as ResponseLike;

      response = await resolveToolCalls(response, message);

      const finalText = extractResponseText(response);

      if (finalText && finalText.trim().length > 0) {
        logger.info(`Sending conversational response to ${author}.`);
        for (const chunk of splitMessage(finalText)) {
          await message.reply(chunk);
        }
      } else {
        logger.warn('OpenAI returned an empty response.');
        await message.reply("I'm not sure how to respond to that.");
      }

      conversationState[channelId] = {
        timestamp: Date.now(),
        responseId: response.id,
      };
    } catch (error) {
      console.error('Error in OpenAI interaction:', error);
      delete conversationState[channelId];
      await message.reply('Sorry, I encountered an error while processing your request.');
    }
  },
};
