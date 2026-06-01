// Live, paid, opt-in smoke tests against the real OpenRouter API. These are SKIPPED unless both
// RUN_LIVE=1 and OPENROUTER_API_KEY are set, so they never run in CI or normal local runs.
//
// Run them with:
//   sudo docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... test yarn test:live
//
// They make a handful of cheap completion calls and cost roughly a few cents per run.
import { describe, expect, it } from 'vitest';
import type { ConversationEntry } from '../types';
import { OpenRouterProvider } from './openRouterProvider';

const RUN_LIVE = process.env.RUN_LIVE === '1' && !!process.env.OPENROUTER_API_KEY;
const LIVE_TIMEOUT = 60_000;

describe.skipIf(!RUN_LIVE)('OpenRouter live smoke tests (paid, opt-in)', () => {
  it(
    'returns text for a plain chat with no tools',
    async () => {
      const provider = new OpenRouterProvider();
      const messages: ConversationEntry[] = [
        {
          kind: 'message',
          role: 'developer',
          content: [{ type: 'text', text: 'You are a test bot. Reply with one short sentence.' }],
        },
        { kind: 'message', role: 'user', content: [{ type: 'text', text: 'Say hello.' }] },
      ];

      const response = await provider.chat({ messages, tools: [] });

      expect(response.text).toBeTruthy();
      expect(response.outputEntries.length).toBeGreaterThanOrEqual(1);
      expect((response.raw as { choices: unknown[] }).choices.length).toBeGreaterThanOrEqual(1);
    },
    LIVE_TIMEOUT,
  );

  it(
    'either calls a tool or replies with text when prompted to remember something',
    async () => {
      const provider = new OpenRouterProvider();
      const messages: ConversationEntry[] = [
        {
          kind: 'message',
          role: 'user',
          content: [{ type: 'text', text: 'Please remember that my favorite color is blue.' }],
        },
      ];

      const response = await provider.chat({ messages, tools: provider.supportedTools });

      // Non-determinism tolerated: a tool call OR a plain text reply both count as success.
      if (response.toolCalls.length > 0) {
        for (const call of response.toolCalls) {
          expect(call.id).toBeTruthy();
          expect(typeof call.name).toBe('string');
          expect(typeof call.arguments).toBe('object');
        }
      } else {
        expect(response.text).toBeTruthy();
      }
    },
    LIVE_TIMEOUT,
  );

  it(
    'parses a response from a backend-pinned model',
    async () => {
      // Provider slug per OpenRouter docs; adjust the model id / provider slug if OpenRouter renames them.
      const provider = new OpenRouterProvider({
        model: 'anthropic/claude-haiku-4.5',
        routing: { only: ['amazon-bedrock'], allow_fallbacks: false },
      });
      const messages: ConversationEntry[] = [
        { kind: 'message', role: 'user', content: [{ type: 'text', text: 'Reply with a single word: hello.' }] },
      ];

      const response = await provider.chat({ messages, tools: [] });

      expect(Boolean(response.text) || response.toolCalls.length > 0).toBe(true);
    },
    LIVE_TIMEOUT,
  );
});
