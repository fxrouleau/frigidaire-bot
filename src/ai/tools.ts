import type { ToolDefinition, ToolHandlerContext } from './types';

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
    required: ['prompt'],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const prompt = String(args.prompt ?? '');
    const refinePrevious = Boolean(args.refine_previous ?? false);

    // Prefer provider-local image generation helper if available (covers providers without server-side images)
    if (ctx.provider.generateImageLocal) {
      return ctx.provider.generateImageLocal(ctx.message, prompt, { refinePrevious });
    }

    if (ctx.provider.generateImage) {
      return ctx.provider.generateImage(ctx.message, prompt);
    }

    return 'This provider does not support image generation.';
  },
};

const switchProviderTool: ToolDefinition = {
  name: 'switch_provider',
  description: 'Switch to a different AI provider without losing context.',
  parameters: {
    type: 'object',
    properties: {
      provider_id: {
        type: 'string',
        description: 'The target provider identifier (e.g., openai, gemini, grok).',
      },
    },
    required: ['provider_id'],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const providerId = String(args.provider_id ?? '').trim();
    if (!providerId) {
      return 'Please provide a provider_id to switch to.';
    }

    const result = ctx.switchProvider(providerId);
    if (result.error) {
      return result.error;
    }

    if (result.provider) {
      return `Switched to provider "${result.provider.displayName}" for this channel while keeping the existing context.`;
    }

    return 'Unable to switch providers right now.';
  },
};

export const toolDefinitions: ToolDefinition[] = [summarizeTool, imageTool, switchProviderTool];
