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

    // Pre-filter: If message is ONLY user mentions with minimal/no text, never respond
    const contentWithoutMentions = message.content.replace(/<@!?\d+>/g, '').trim();
    if (contentWithoutMentions.length < 3) {
      return { shouldRespond: false, reason: 'message is just mentions with no content' };
    }

    // Pre-filter: If message contains user mentions but bot isn't explicitly named, be very skeptical
    const hasUserMentions = /<@!?\d+>/.test(message.content);
    const botNameInMessage = message.content.toLowerCase().includes(botName.toLowerCase());

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

    const systemPrompt = `You are a gate classifier for a Discord bot named "${botName}".

Your ONLY job: decide if this SPECIFIC message is trying to get the bot to respond or do something.

DEFAULT TO FALSE. Be extremely conservative. Only return true if you're 100% certain the user wants the bot to participate in THIS message.

Return TRUE only when:
- User directly asks the bot a question ("${botName}, what time is it?")
- User gives the bot a command ("${botName} summarize this convo")
- User explicitly solicits the bot's input ("hey ${botName}, thoughts?")

Return FALSE when:
- Message is ONLY an @mention of someone else — NO BOT INVOLVEMENT AT ALL
- Message is talking ABOUT the bot, not TO it ("the bot is being weird", "why did the bot answer")
- Message is general chat/banter between users ("lol", "yeah", "ok", "im in")
- Message is a reply to another user (unless explicitly asking the bot too)
- User is asking someone else a question
- The bot's name appears but isn't being addressed ("I used the bot earlier")
- You have ANY doubt whatsoever — default to FALSE

${hasUserMentions && !botNameInMessage ? 'IMPORTANT: This message contains @mentions of other users but does NOT mention the bot by name. Unless the message is CLEARLY a command/question for the bot, return FALSE.' : ''}

The bot is already triggered by explicit @mentions and replies, so this classifier should ONLY catch natural language directed specifically at the bot without @mentions.

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
    const jsonText = text
      .replace(/^```(?:json)?\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();

    const parsed = JSON.parse(jsonText) as { respond: boolean; reason: string };
    return { shouldRespond: parsed.respond, reason: parsed.reason };
  } catch (error) {
    logger.warn('Gate classifier error, failing closed:', error);
    return { shouldRespond: false, reason: 'classifier error' };
  }
}
