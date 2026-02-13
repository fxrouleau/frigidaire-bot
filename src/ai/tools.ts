import * as process from 'node:process';
import OpenAI from 'openai';
import { logger } from '../logger';
import { MemoryStore } from './memory/memoryStore';
import type { ToolDefinition, ToolHandlerContext } from './types';

let memoryStore: MemoryStore | undefined;

export function getMemoryStore(): MemoryStore {
  if (!memoryStore) {
    memoryStore = new MemoryStore();
  }
  return memoryStore;
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
    },
    required: ['prompt', 'refine_previous'],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const prompt = String(args.prompt ?? '');
    const refinePrevious = Boolean(args.refine_previous ?? false);

    if (ctx.provider.generateImageLocal) {
      return ctx.provider.generateImageLocal(ctx.message, prompt, { refinePrevious });
    }

    if (ctx.provider.generateImage) {
      return ctx.provider.generateImage(ctx.message, prompt);
    }

    return 'This provider does not support image generation.';
  },
};

const rememberFactTool: ToolDefinition = {
  name: 'remember_fact',
  description:
    'Save something to long-term memory. Categories: "fact" (names, jobs, locations), "preference" (likes/dislikes), "personality" (communication style), "event" (something that happened), "vibe" (server culture, in-jokes).',
  parameters: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['fact', 'preference', 'personality', 'event', 'vibe'] },
      subject: { type: 'string', description: 'Who/what this is about. Use Discord display name or "server".' },
      content: { type: 'string', description: 'What to remember. Be concise.' },
    },
    required: ['category', 'subject', 'content'],
    additionalProperties: false,
  },
  handler: async (_ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const store = getMemoryStore();
    const id = store.save({
      category: String(args.category ?? 'fact'),
      subject: String(args.subject ?? 'general'),
      content: String(args.content ?? ''),
      source: 'conversation',
    });
    return `Saved to memory (id: ${id}).`;
  },
};

const recallMemoriesTool: ToolDefinition = {
  name: 'recall_memories',
  description:
    'Search long-term memory. Use when someone references the past, when you need context about someone, or to check what you know before asking.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for.' },
      subject: { type: 'string', description: 'Optional: filter by person name or "server".' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (_ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const store = getMemoryStore();
    const query = String(args.query ?? '');
    const subject = args.subject ? String(args.subject) : undefined;

    let results = subject ? store.getBySubject(subject) : [];

    // Also search via FTS
    try {
      const ftsResults = store.search(query, 15);
      const existingIds = new Set(results.map((r) => r.id));
      for (const r of ftsResults) {
        if (!existingIds.has(r.id)) {
          results.push(r);
        }
      }
    } catch {
      // FTS search may fail on certain queries; fall back to subject-only results
    }

    if (results.length === 0) {
      // Fall back to recent memories
      results = store.getRecent(10);
    }

    if (results.length === 0) {
      return 'No memories found.';
    }

    return results
      .slice(0, 20)
      .map((m) => `[id:${m.id}] [${m.category}] ${m.subject}: ${m.content}`)
      .join('\n');
  },
};

const forgetMemoryTool: ToolDefinition = {
  name: 'forget_memory',
  description: 'Remove a specific memory. Call recall_memories first to find the ID.',
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
    const store = getMemoryStore();
    const id = Number(args.memory_id);
    if (Number.isNaN(id)) {
      return 'Invalid memory ID.';
    }
    store.deactivate(id);
    return `Memory #${id} has been forgotten.`;
  },
};

let searchClient: OpenAI | undefined;

function getSearchClient(): OpenAI | undefined {
  if (!process.env.OPENROUTER_API_KEY) return undefined;
  if (!searchClient) {
    searchClient = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: { 'X-Title': 'Frigidaire Bot' },
    });
  }
  return searchClient;
}

const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description:
    "Search the web for current information. Use SPARINGLY — only when you genuinely need real-time data you couldn't possibly know (live scores, recent news, release dates, etc).",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (_ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const query = String(args.query ?? '');
    const client = getSearchClient();
    if (!client) {
      return 'Web search is not available (missing API key).';
    }

    try {
      // Use a small model with web search tool through OpenRouter
      const response = await client.chat.completions.create({
        model: 'google/gemini-2.5-flash',
        max_tokens: 1024,
        messages: [
          {
            role: 'system',
            content: 'You are a search assistant. Return concise, factual results for the query. No commentary.',
          },
          { role: 'user', content: query },
        ],
        // @ts-expect-error OpenRouter-specific field — enable web search plugin
        plugins: [{ id: 'web' }],
        provider: { zdr: true },
      });

      const text = response.choices[0]?.message?.content?.trim();
      return text || 'No search results found.';
    } catch (error) {
      logger.error('Web search failed:', error);
      return 'Web search failed.';
    }
  },
};

export const toolDefinitions: ToolDefinition[] = [
  summarizeTool,
  imageTool,
  rememberFactTool,
  recallMemoriesTool,
  forgetMemoryTool,
  webSearchTool,
];
