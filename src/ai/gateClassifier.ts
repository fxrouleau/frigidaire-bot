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

/**
 * Common names/nicknames users might use to address the bot.
 * Checked case-insensitively with word boundaries against the message content.
 */
const BOT_ALIASES = ['frigidaire', 'fridge', 'fridge bot', 'fridgebot', 'bot'];

function contentAddressesBot(content: string, botName: string): boolean {
  const lower = content.toLowerCase();
  if (lower.includes(botName.toLowerCase())) return true;
  return BOT_ALIASES.some((alias) => {
    // Word-boundary check so "robot", "about", etc. don't match
    const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(content);
  });
}

export async function classifyMessage(message: Message): Promise<GateResult> {
  try {
    const botName = message.client.user.displayName;
    const authorName = message.member?.displayName || message.author.username;

    // Strip Discord mentions to get the actual text content
    const contentWithoutMentions = message.content.replace(/<@!?\d+>/g, '').trim();

    // Pre-filter: No real text content -> skip
    if (contentWithoutMentions.length < 3) {
      return { shouldRespond: false, reason: 'message is just mentions with no content' };
    }

    // Pre-filter: Check if the text addresses the bot by name or nickname
    const mentionsBot = contentAddressesBot(contentWithoutMentions, botName);

    // If message @mentions other users but doesn't reference the bot at all, bail early
    const hasUserMentions = /<@!?\d+>/.test(message.content);
    if (hasUserMentions && !mentionsBot) {
      return { shouldRespond: false, reason: 'mentions other users but not the bot' };
    }

    let replyContext = '';
    if (message.reference?.messageId) {
      try {
        const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
        const isBotReply = repliedTo.author.id === message.client.user.id;
        const replyAuthor = repliedTo.member?.displayName || repliedTo.author.username;
        replyContext = `[Reply to ${replyAuthor}${isBotReply ? ' (the bot)' : ''}: "${repliedTo.content.slice(0, 200)}"]`;
      } catch {
        // Couldn't fetch the referenced message, proceed without context
      }
    }

    const aliasListStr = [botName, ...BOT_ALIASES].map((a) => `"${a}"`).join(', ');

    const systemPrompt = `You classify whether a Discord message is directed AT a bot named "${botName}" (also called ${aliasListStr}).

Respond with JSON: {"respond": true/false, "reason": "brief"}

TRUE — the user is talking TO the bot:
- "bot what time is it" -> true
- "fridge bot summarize the chat" -> true
- "hey bot, thoughts?" -> true

FALSE — the user is NOT talking to the bot:
- "lol the bot is broken" (talking ABOUT it) -> false
- "yeah I agree" (general chat) -> false
- "nice one bot" (reaction, not a request) -> false
- "@someone what do you think" (talking to someone else) -> false

Default to false if unsure.`;

    const userPrompt = `${replyContext ? `${replyContext}\n` : ''}${authorName}: ${message.content}`;

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
