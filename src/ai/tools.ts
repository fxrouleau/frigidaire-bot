import { getMemoryStore } from './memory';
import { type Memory, SELF_DIAGNOSIS_CATEGORIES } from './memory/memoryStore';
import { emojiSyntax } from './promptSections';
import { birthdayTools } from './tools/birthdays';
import { costTools } from './tools/costs';
import { featureRequestTools } from './tools/featureRequest';
import { linkReaderTools } from './tools/linkReader';
import { messageSearchTools } from './tools/messageSearch';
import { reactTools } from './tools/react';
import { reminderTools } from './tools/reminders';
import { sandboxTools } from './tools/sandbox';
import type { ToolDefinition, ToolHandlerContext } from './types';

// The categories the chat model may write. Everything the model sends is untrusted text: a
// hallucinated 'Fact', 'image' or 'capability_gap' would create a never-expiring or self-diagnosis
// polluting row, so arguments are whitelisted here exactly like the learner whitelists its own.
const CHAT_MEMORY_CATEGORIES = ['fact', 'preference', 'personality', 'event', 'vibe'] as const;
type ChatMemoryCategory = (typeof CHAT_MEMORY_CATEGORIES)[number];

function parseCategory(raw: unknown): ChatMemoryCategory | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  return (CHAT_MEMORY_CATEGORIES as readonly string[]).includes(normalized)
    ? (normalized as ChatMemoryCategory)
    : undefined;
}

/** Parses a positive integer id from a number or numeric string; undefined for anything else. */
function parseId(raw: unknown): number | undefined {
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Parses an integer within [min, max], falling back to the default for anything else. */
function parseLimit(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function optionalString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatMemoryLine(m: Memory): string {
  return `[id:${m.id}] [${m.category}] ${m.subject}: ${m.content} (saved: ${m.created_at}, updated: ${m.updated_at})`;
}

const summarizeTool: ToolDefinition = {
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
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    if (!ctx.provider.summarizeMessages) {
      return 'This provider does not support summarizing messages.';
    }
    const startTime = String(args.start_time ?? '');
    const endTime = String(args.end_time ?? '');
    return ctx.provider.summarizeMessages(ctx.message, startTime, endTime);
  },
};

const imageTool: ToolDefinition = {
  name: 'generate_image',
  description:
    'Generate an image from a prompt. If refine_previous is true, improve the most recently generated image for this channel using the refinement text.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'A detailed description of the image to generate.',
      },
      refine_previous: {
        type: 'boolean',
        description: 'If true, refine the most recently generated image for this channel.',
      },
      source_image_url: {
        type: 'string',
        description:
          'URL of an image from the conversation to use as reference/source for the generation. Pass this when the user wants to transform, edit, or reference an existing image.',
      },
    },
    required: ['prompt', 'refine_previous'],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    if (!ctx.provider.generateImage) {
      return 'This provider does not support image generation.';
    }
    const prompt = String(args.prompt ?? '');
    const refinePrevious = args.refine_previous === true || args.refine_previous === 'true';
    const sourceImageUrl = optionalString(args.source_image_url);
    return ctx.provider.generateImage(ctx.message, prompt, { refinePrevious, sourceImageUrl, turn: ctx.turn });
  },
};

const rememberFactTool: ToolDefinition = {
  name: 'remember_fact',
  description:
    'Save something to long-term memory. Categories: "fact" (names, jobs, locations), "preference" (likes/dislikes), "personality" (communication style), "event" (something that happened — expires automatically after ~2 weeks; use "fact" for anything that should be remembered permanently), "vibe" (server culture, in-jokes).',
  parameters: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: [...CHAT_MEMORY_CATEGORIES] },
      subject: { type: 'string', description: 'Who/what this is about. Use Discord display name or "server".' },
      content: { type: 'string', description: 'What to remember. Be concise.' },
    },
    required: ['category', 'subject', 'content'],
    additionalProperties: false,
  },
  handler: async (_ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const category = parseCategory(args.category);
    if (!category) {
      return `Invalid category "${String(args.category)}". Use one of: ${CHAT_MEMORY_CATEGORIES.join(', ')}.`;
    }
    const content = optionalString(args.content);
    if (!content) {
      return 'Nothing to remember: content was empty.';
    }
    const subject = optionalString(args.subject) ?? 'general';

    const store = getMemoryStore();
    const id = await store.save({ category, subject, content, source: 'conversation' });
    return `Saved to memory (id: ${id}).`;
  },
};

const recallMemoriesTool: ToolDefinition = {
  name: 'recall_memories',
  description:
    'Search long-term memory: facts, preferences, personality, events, and server vibe. Use when someone references the past, for "what do you know about X" questions, to check what you know before asking, or to find the id of a memory you need to update or forget. Searches by subject name, topic keywords, and category. Bot self-diagnosis entries (capability gaps, errors, improvement ideas) are not included — use query_self_diagnosis for those.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "What to search for — a person's name, a topic, an event, etc." },
      subject: { type: 'string', description: 'Optional: filter by person display name or "server".' },
      category: {
        type: 'string',
        enum: [...CHAT_MEMORY_CATEGORIES, 'all'],
        description: 'Optional category filter. Use "all" or omit to search everything.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (_ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const store = getMemoryStore();
    const query = optionalString(args.query) ?? '';
    const subject = optionalString(args.subject);
    const category = args.category === 'all' ? undefined : parseCategory(args.category);

    const results: Memory[] = [];
    const seenIds = new Set<number>();
    const add = (rows: Memory[]) => {
      for (const row of rows) {
        if (category && row.category !== category) continue;
        if (seenIds.has(row.id)) continue;
        seenIds.add(row.id);
        results.push(row);
      }
    };

    // 1. Subject-keyed rows first: an explicit subject filter, then the query itself read as a name.
    if (subject) add(store.getBySubject(subject, 20));
    if (query) add(store.getBySubject(query, 20));

    // 2. Hybrid (semantic + keyword) search for topic matches.
    if (query) {
      try {
        add(await store.search(query, 20));
      } catch {
        // Search may fail (e.g. embeddings and FTS both unavailable); fall back to subject-only results.
      }
    }

    // 3. A category filter with few hits widens to the category's most recent rows.
    if (category && results.length < 5) add(store.getByCategory(category, 20));

    if (results.length === 0) {
      return 'No memories found matching that query.';
    }

    return `Found ${results.length} memories:\n${results.slice(0, 25).map(formatMemoryLine).join('\n')}`;
  },
};

const forgetMemoryTool: ToolDefinition = {
  name: 'forget_memory',
  description:
    "Remove a memory that's been superseded by a correction, is now wrong, or that someone explicitly asked you to forget. Call recall_memories first to get its id. Don't forget memories over jokes or banter.",
  parameters: {
    type: 'object',
    properties: {
      memory_id: { type: 'number', description: 'The memory ID from recall_memories.' },
      reason: { type: 'string', description: 'Why.' },
    },
    required: ['memory_id'],
    additionalProperties: false,
  },
  handler: async (_ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const id = parseId(args.memory_id);
    if (id === undefined) {
      return 'Invalid memory ID.';
    }
    const forgotten = getMemoryStore().deactivate(id);
    return forgotten ? `Memory #${id} has been forgotten.` : `No active memory with id ${id} — nothing to forget.`;
  },
};

const querySelfDiagnosisTool: ToolDefinition = {
  name: 'query_self_diagnosis',
  description:
    'Check what the bot has been struggling with or what could be improved. Use when asked "what have you been struggling with?", "what should we improve?", "any issues lately?", "what are your pain points?". Entries are prefixed with [id:N]; pass an id to forget_memory to remove one.',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: [...SELF_DIAGNOSIS_CATEGORIES, 'all'],
        description: 'Filter by type of issue. Use "all" to see everything.',
      },
      limit: {
        type: 'number',
        description: 'Max results to return. Default 15.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (_ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const store = getMemoryStore();
    const requested = optionalString(args.category);
    const category =
      requested && requested !== 'all' && (SELF_DIAGNOSIS_CATEGORIES as readonly string[]).includes(requested)
        ? requested
        : undefined;
    const limit = parseLimit(args.limit, 15, 1, 50);

    let results: Memory[] = [];

    if (category) {
      results = store.getByCategory(category, limit * 3);
    } else {
      for (const cat of SELF_DIAGNOSIS_CATEGORIES) {
        results.push(...store.getByCategory(cat, limit * 3));
      }
    }

    // Filter to only bot-related subjects FIRST, then sort and slice
    results = results.filter((r) => r.subject === 'bot' || r.subject === 'server');
    results.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    results = results.slice(0, limit);

    if (results.length === 0) {
      return "No self-diagnosis data found yet. The bot hasn't logged any issues or improvement ideas.";
    }

    // [id:N] prefixes keep forget_memory usable for self-diagnosis entries — search() excludes these
    // categories, so this tool is their only discovery path.
    const formatted = results.map((m) => `[id:${m.id}] [${m.category}] ${m.content} (${m.updated_at})`).join('\n');

    return `Self-diagnosis (${results.length} entries):\n${formatted}`;
  },
};

const getEmojiTool: ToolDefinition = {
  name: 'get_emoji',
  description:
    'Look up a server custom emoji by name or by the reaction you want, and get the exact syntax to post it. Only call this once you have already decided that a single emoji IS the reply or the punchline — most replies never need one.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Emoji name or the reaction you want, e.g. "trolle" or "panic".' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (_ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const query = (optionalString(args.query) ?? '').toLowerCase();
    if (!query) return 'No matching emoji. Reply in plain text.';
    const hits = getMemoryStore()
      .getUsableEmojis()
      .filter((e) => e.name.toLowerCase().includes(query) || (e.caption ?? '').toLowerCase().includes(query))
      .slice(0, 5);
    if (hits.length === 0) return 'No matching emoji. Reply in plain text.';
    return hits.map((e) => `${emojiSyntax(e)} — ${e.caption ?? e.name}`).join('\n');
  },
};

// Every tool the chat model can call. Feature tools live in their own modules under ./tools/ so each
// feature owns its file; a tool with an `isEnabled` gate is only offered when its feature is configured.
export const toolDefinitions: ToolDefinition[] = [
  summarizeTool,
  imageTool,
  rememberFactTool,
  recallMemoriesTool,
  forgetMemoryTool,
  querySelfDiagnosisTool,
  getEmojiTool,
  ...reactTools,
  ...reminderTools,
  ...birthdayTools,
  ...messageSearchTools,
  ...linkReaderTools,
  ...sandboxTools,
  ...featureRequestTools,
  ...costTools,
];
