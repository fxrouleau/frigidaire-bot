// Live, paid, opt-in checks that the command prompts behave on the real chat model (CHAT_MODEL):
// Translate's ALREADY_ENGLISH contract and Remember this's JSON contract. SKIPPED unless both RUN_LIVE=1
// and OPENROUTER_API_KEY are set. A handful of short completions: well under a cent per run.
//
//   docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... test yarn test:live
import { describe, expect, it } from 'vitest';
import { createCompletion } from './completion';
import { buildRememberPrompt, parseRememberDecision } from './rememberThis';
import { TRANSLATE_SYSTEM_PROMPT } from './translate';

const RUN_LIVE = process.env.RUN_LIVE === '1' && !!process.env.OPENROUTER_API_KEY;
const LIVE_TIMEOUT = 60_000;

describe.skipIf(!RUN_LIVE)('context-menu command prompts (live, paid, opt-in)', () => {
  const complete = createCompletion();

  it(
    'translates Québécois French into English',
    async () => {
      const answer = await complete({
        system: TRANSLATE_SYSTEM_PROMPT,
        user: "<<<\nc'est tiguidou, on se voit à soir au dépanneur\n>>>",
        maxTokens: 4000,
      });
      expect(answer).toBeTruthy();
      expect(answer).not.toContain('ALREADY_ENGLISH');
      expect(answer?.toLowerCase()).toMatch(/tonight|this evening/);
    },
    LIVE_TIMEOUT,
  );

  it(
    'answers ALREADY_ENGLISH for English text',
    async () => {
      const answer = await complete({
        system: TRANSLATE_SYSTEM_PROMPT,
        user: '<<<\nwho is down for league tonight\n>>>',
        maxTokens: 4000,
      });
      expect(answer?.replace(/[.\s]/g, '')).toBe('ALREADY_ENGLISH');
    },
    LIVE_TIMEOUT,
  );

  it(
    'distills a durable fact as JSON, and declines a throwaway message',
    async () => {
      const user = (message: string) =>
        `Today (Eastern time): 2026-09-25\nALREADY KNOWN about Jason:\n(nothing yet)\n\nMESSAGE from Jason:\n<<<\n${message}\n>>>`;

      const durable = parseRememberDecision(
        (await complete({
          system: buildRememberPrompt('Jason'),
          user: user('finally done with school, I start as a nurse at the Jewish General on monday'),
          maxTokens: 1000,
          temperature: 0.1,
        })) ?? '',
      );
      expect(durable?.fact).toBeTruthy();
      expect(durable?.fact?.toLowerCase()).toContain('nurse');

      const throwaway = parseRememberDecision(
        (await complete({
          system: buildRememberPrompt('Jason'),
          user: user('LMAOOO no way'),
          maxTokens: 1000,
          temperature: 0.1,
        })) ?? '',
      );
      expect(throwaway).toBeDefined();
      expect(throwaway?.fact).toBeNull();
    },
    LIVE_TIMEOUT,
  );
});
