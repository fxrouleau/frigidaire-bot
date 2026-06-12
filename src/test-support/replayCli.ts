// CLI for reproducing captured/fixture exchanges locally: `yarn replay <path-to-json>`.
// Accepts either an ErrorCapture (from src/ai/debugCapture.ts) or an OpenRouterFixture.
// Exit code 1 if any step reproduced an error (the bug still reproduces), 0 if everything parsed.
import * as fs from 'node:fs';
import type OpenAI from 'openai';
import { OpenRouterProvider, parseOpenRouterResponse } from '../ai/providers/openRouterProvider';
import type { ConversationEntry } from '../ai/types';
import { type OpenRouterFixture, createReplayClient } from './openRouterFetch';

type LooseInput = {
  version?: unknown;
  kind?: unknown;
  model?: unknown;
  status?: unknown;
  response?: unknown;
  request?: unknown;
  conversationEntries?: unknown;
  error?: { message?: unknown; stack?: unknown; rawResponse?: unknown } | unknown;
};

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function firstStackLines(stack: string | undefined, count = 5): string {
  if (!stack) return '(no stack)';
  return stack.split('\n').slice(0, count).join('\n');
}

function getPayload(input: LooseInput): unknown {
  const err = input.error as { rawResponse?: unknown } | undefined;
  if (err && typeof err === 'object' && 'rawResponse' in err && err.rawResponse !== undefined) {
    return err.rawResponse;
  }
  if (input.response !== undefined) {
    return input.response;
  }
  return undefined;
}

function tryParse(payload: unknown): boolean {
  section('Parsing payload through parseOpenRouterResponse');
  try {
    const parsed = parseOpenRouterResponse(payload as OpenAI.ChatCompletion);
    console.log('Parsed successfully.');
    console.log(`  text: ${parsed.text ? JSON.stringify(parsed.text) : '(none)'}`);
    console.log(`  toolCalls: ${parsed.toolCalls.length}`);
    for (const call of parsed.toolCalls) {
      console.log(`    - ${call.name} (id: ${call.id || '(empty)'}) args=${JSON.stringify(call.arguments)}`);
    }
    console.log(`  outputEntries: ${parsed.outputEntries.length}`);
    return false;
  } catch (error) {
    console.log('Reproduced an error while parsing:');
    console.log(`  message: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error) {
      console.log(`  stack:\n${firstStackLines(error.stack)}`);
    }
    return true;
  }
}

async function tryRebuildRequest(input: LooseInput, payload: unknown): Promise<boolean> {
  section('Rebuilding the request from conversationEntries');
  const conversationEntries = input.conversationEntries as ConversationEntry[];
  const model = typeof input.model === 'string' ? input.model : undefined;

  const fixture: OpenRouterFixture = {
    version: 1,
    status: typeof input.status === 'number' ? input.status : 200,
    response: payload,
  };

  let capturedRequest: unknown;
  const provider = new OpenRouterProvider({
    client: createReplayClient(fixture, (body) => {
      capturedRequest = body;
    }),
    model,
  });

  try {
    const response = await provider.chat({
      messages: conversationEntries,
      tools: provider.supportedTools,
      toolChoice: 'auto',
    });
    console.log('Request body that was sent to the client:');
    console.log(JSON.stringify(capturedRequest, null, 2));
    console.log('\nOutcome: chat() resolved.');
    console.log(`  text: ${response.text ? JSON.stringify(response.text) : '(none)'}`);
    console.log(`  toolCalls: ${response.toolCalls.length}`);
    return false;
  } catch (error) {
    console.log('Request body that was sent to the client:');
    console.log(JSON.stringify(capturedRequest, null, 2));
    console.log('\nOutcome: chat() threw.');
    console.log(`  message: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error) {
      console.log(`  stack:\n${firstStackLines(error.stack)}`);
    }
    return true;
  }
}

async function main(): Promise<number> {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log('Usage: yarn replay <path-to-capture-or-fixture.json>');
    return 2;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const input = JSON.parse(raw) as LooseInput;

  section('Input');
  console.log(`  file: ${filePath}`);
  console.log(`  kind: ${input.kind ?? '(fixture / unknown)'}`);
  console.log(`  model: ${input.model ?? '(unspecified)'}`);

  let reproducedError = false;

  const payload = getPayload(input);
  if (payload !== undefined) {
    if (tryParse(payload)) {
      reproducedError = true;
    }
  } else {
    section('Parsing payload through parseOpenRouterResponse');
    console.log('No rawResponse/response payload present in the file; skipping parse step.');
  }

  if (Array.isArray(input.conversationEntries) && payload !== undefined) {
    if (await tryRebuildRequest(input, payload)) {
      reproducedError = true;
    }
  }

  section('Result');
  console.log(
    reproducedError
      ? 'At least one step reproduced an error (the bug still reproduces).'
      : 'Everything parsed cleanly.',
  );

  return reproducedError ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('replay CLI crashed:', error);
    process.exitCode = 1;
  });
