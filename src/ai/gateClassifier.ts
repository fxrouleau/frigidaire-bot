import * as process from 'node:process';
import type { Message } from 'discord.js';
import OpenAI from 'openai';
import { logger } from '../logger';

interface GateResult {
  shouldRespond: boolean;
  reason: string;
}

let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'X-Title': 'Frigidaire Bot',
      },
    });
  }
  return client;
}

export async function classifyMessage(message: Message): Promise<GateResult> {
  try {
    const botName = message.client.user.displayName;
    const authorName = message.member?.displayName || message.author.username;

    let replyContext = '';
    if (message.reference?.messageId) {
      try {
        const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
        const isBotReply = repliedTo.author.id === message.client.user.id;
        const replyAuthor = repliedTo.member?.displayName || repliedTo.author.username;
        replyContext = `This message is a reply to a message by ${replyAuthor}${isBotReply ? ' (the bot)' : ''}: "${repliedTo.content.slice(0, 200)}"`;
      } catch {
        // Couldn't fetch the referenced message, proceed without context
      }
    }

    const systemPrompt = `You are a gate classifier for a Discord bot named "${botName}". Your job is to decide whether the bot should respond to a message.

The bot should respond when:
- The message is a reply to one of the bot's messages
- The message clearly addresses the bot by name
- The message is clearly directed at the bot

The bot should NOT respond when:
- The message is general chat between users
- The message mentions the bot's name only in passing
- The message is a reply to another user's message

Respond with JSON only: {"respond": true/false, "reason": "brief explanation"}`;

    const userPrompt = `${replyContext ? `${replyContext}\n\n` : ''}Author: ${authorName}\nMessage: ${message.content}`;

    const openai = getClient();
    const response = await openai.chat.completions.create({
      model: 'anthropic/claude-haiku-4-5',
      max_tokens: 100,
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'gate_decision',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              respond: { type: 'boolean' },
              reason: { type: 'string' },
            },
            required: ['respond', 'reason'],
            additionalProperties: false,
          },
        },
      },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      // @ts-expect-error OpenRouter-specific field for zero data retention
      provider: { zdr: true },
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) return { shouldRespond: false, reason: 'empty response' };

    // Strip markdown code blocks if present (fallback for when response_format doesn't work)
    const jsonText = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

    const parsed = JSON.parse(jsonText) as { respond: boolean; reason: string };
    return { shouldRespond: parsed.respond, reason: parsed.reason };
  } catch (error) {
    logger.warn('Gate classifier error, failing closed:', error);
    return { shouldRespond: false, reason: 'classifier error' };
  }
}
