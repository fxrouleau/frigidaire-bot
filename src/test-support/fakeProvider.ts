// A scripted AiProvider for tests: hand it a list of responses (or errors, or functions) and it
// returns them in order from chat(), recording every input it received.
import type { AiProvider, ConversationEntry, ProviderChatResponse, ProviderToolDefinition } from '../ai/types';

export type ChatInput = {
  messages: ConversationEntry[];
  tools: ProviderToolDefinition[];
  toolChoice?: 'auto' | 'none';
  thoughts?: unknown;
};

export type ScriptStep = ProviderChatResponse | { error: Error } | ((input: ChatInput) => ProviderChatResponse);

const DEFAULT_SUPPORTED_TOOLS: ProviderToolDefinition[] = [
  {
    name: 'echo_tool',
    type: 'function',
    description: 'Echo tool for tests',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    hostHandled: true,
  },
];

function isErrorStep(step: ScriptStep): step is { error: Error } {
  return (
    typeof step === 'object' && step !== null && 'error' in step && (step as { error: unknown }).error instanceof Error
  );
}

export class FakeProvider implements AiProvider {
  readonly id = 'fake';
  readonly displayName = 'Fake Provider';
  readonly personality = '';
  readonly defaultModel = 'fake-model';
  readonly supportedTools: ProviderToolDefinition[];
  readonly calls: ChatInput[] = [];

  private readonly script: ScriptStep[];

  constructor(script: ScriptStep[], opts?: { supportedTools?: ProviderToolDefinition[] }) {
    this.script = [...script];
    this.supportedTools = opts?.supportedTools ?? DEFAULT_SUPPORTED_TOOLS;
  }

  async chat(input: ChatInput): Promise<ProviderChatResponse> {
    this.calls.push(structuredClone(input));

    const step = this.script.shift();
    if (step === undefined) {
      throw new Error('FakeProvider script exhausted: chat() called more times than scripted');
    }

    if (typeof step === 'function') {
      return step(input);
    }

    if (isErrorStep(step)) {
      throw step.error;
    }

    return step;
  }
}

export function textResponse(text: string): ProviderChatResponse {
  return {
    text,
    toolCalls: [],
    outputEntries: [
      {
        kind: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    ],
    raw: undefined,
  };
}

export function toolCallResponse(
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  text?: string,
): ProviderChatResponse {
  const outputEntries: ConversationEntry[] = calls.map((c) => ({
    kind: 'tool_call',
    id: c.id,
    name: c.name,
    arguments: c.arguments,
  }));

  if (text) {
    outputEntries.push({
      kind: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
    });
  }

  return {
    text,
    toolCalls: calls,
    outputEntries,
    raw: undefined,
  };
}

export function errorStep(message: string): ScriptStep {
  return { error: new Error(message) };
}
