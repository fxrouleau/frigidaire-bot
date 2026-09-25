// "Is this run of messages one of their rambles?" — judged by the cheap chat model, not the decision
// model: the call is a comparison of style and content against real examples (few-shot), which is what
// a chat model is good at and what a small calibrated yes/no model is not built for.
//
// The model sees real rambles from the ramble channel, some of the person's normal messages, what was
// said right before the run, and the run itself, and answers {"ramble": bool, "confidence": 0..1}.
// Every call is ZDR-routed and tagged 'ramble'. Reasoning is asked at the lowest effort: the default
// chat model (z-ai/glm-5.3-flash) reasons at 'max' by default, which is pure cost for a yes/no, and
// OpenRouter maps 'low' to the nearest effort a model supports (non-reasoning models ignore it).
// Fails closed: no client, an API error or an unparseable answer ⇒ undefined ⇒ no nudge.
import type OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { getOpenRouterClient } from '../ai/openRouterClient';
import { featureRequestOptions } from '../ai/usage';
import { config } from '../config';
import { logger } from '../logger';
import type { RambleExamples } from './rambleExamples';
import { truncate } from './text';

// Headroom for a low-effort reasoning pass before the few tokens of JSON (reasoning counts toward
// max_tokens on most providers).
const MAX_TOKENS = 1500;
const TIMEOUT_MS = 30_000;
const RUN_LINE_MAX_CHARS = 1200;
const RUN_MAX_CHARS = 5000;
const BEFORE_LINE_MAX_CHARS = 200;

export type RambleLine = { author: string; text: string; self?: boolean; replyTo?: string };

export type RambleJudgeInput = {
  /** The person's current display name. */
  author: string;
  /** Their run of messages, oldest first (nobody else in between). */
  run: Array<{ text: string; replyTo?: string }>;
  /** The few messages right before the run (other people, the bot marked), oldest first. */
  before: RambleLine[];
  examples: RambleExamples;
};

export type RambleVerdict = { ramble: boolean; confidence: number };

export type RambleJudge = (input: RambleJudgeInput) => Promise<RambleVerdict | undefined>;

export const RAMBLE_SYSTEM_PROMPT = `You judge one thing in a private Discord server between close friends: whether a member's latest run of messages is one of their rambles, or just them talking normally.

The group made a whole channel for this member's rambles. A ramble is content, not volume: monologue-ish, stream-of-consciousness, very weird rambling. Talking AT the chat instead of with it: a winding rant or theory nobody asked for, an oddly specific tangent that keeps going, escalating weirdness, thoughts spilling out one after another while nobody engages.

NOT a ramble: answering someone or reacting to what was just said; normal banter, even several messages in a row; a quick story or a normal complaint; hype or excitement; sharing a link, clip, screenshot or game stats; crude or edgy jokes (that is normal here); talking to the bot. Several short messages in a row are normal chat unless their content is ramble-like.

Compare the run with the real rambles and with the member's normal messages when they are given.

Answer with JSON only, no other text: {"ramble": true or false, "confidence": a number from 0 to 1 for how sure you are of that answer}`;

function block(title: string, lines: string[]): string {
  return `${title}\n${lines.join('\n')}`;
}

/** The user message: examples first (they are the same all day), then the context and the run. */
export function buildRambleUserMessage(input: RambleJudgeInput): string {
  const sections: string[] = [];
  const { rambles, normal, ramblesAreTheirs } = input.examples;
  if (rambles.length > 0) {
    const whose = ramblesAreTheirs
      ? `REAL RAMBLES by ${input.author}, from the channel the group made for them:`
      : "REAL RAMBLES from the ramble channel (other members'; none of this member's are archived yet):";
    sections.push(
      block(
        whose,
        rambles.map((run, i) => `--- ramble ${i + 1} ---\n${run}`),
      ),
    );
  } else {
    sections.push('(No archived rambles to compare with: judge from the description alone.)');
  }
  if (normal.length > 0) {
    sections.push(
      block(
        `${input.author}'s NORMAL messages in the main chat, for contrast:`,
        normal.map((text) => `- ${text}`),
      ),
    );
  }
  sections.push(
    input.before.length > 0
      ? block(
          'RIGHT BEFORE THE RUN:',
          input.before.map(
            (line) =>
              `${line.self ? `${line.author} (the bot)` : line.author}: ${truncate(line.text, BEFORE_LINE_MAX_CHARS)}`,
          ),
        )
      : 'RIGHT BEFORE THE RUN: (nothing in the last few minutes)',
  );
  sections.push(
    block(
      `THE RUN TO JUDGE: ${input.author}, ${input.run.length} message${input.run.length === 1 ? '' : 's'} in a row with nobody else in between:`,
      runLines(input.run),
    ),
  );
  sections.push(`Is this run one of ${input.author}'s rambles? JSON only.`);
  return sections.join('\n\n');
}

/** The run's lines, newest kept when the whole run is too long to send. */
function runLines(run: RambleJudgeInput['run']): string[] {
  const lines = run.map(
    (entry) => `${entry.replyTo ? `(replying to ${entry.replyTo}) ` : ''}${truncate(entry.text, RUN_LINE_MAX_CHARS)}`,
  );
  let total = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length;
    if (total > RUN_MAX_CHARS && kept.length > 0) break;
    kept.unshift(lines[i]);
  }
  if (kept.length < lines.length) kept.unshift(`(${lines.length - kept.length} earlier message(s) not shown)`);
  return kept;
}

/**
 * Reads the verdict out of the model's answer: the first JSON object with a boolean `ramble`. A
 * confidence given as a percentage is scaled; a missing or invalid one counts as 0 (never nudges).
 */
export function parseRambleVerdict(text: string): RambleVerdict | undefined {
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const { ramble, confidence } = parsed as { ramble?: unknown; confidence?: unknown };
  if (typeof ramble !== 'boolean') return undefined;
  let value = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0;
  if (value > 1 && value <= 100) value /= 100;
  return { ramble, confidence: Math.min(1, Math.max(0, value)) };
}

type OpenRouterJudgeBody = {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  reasoning: { effort: 'low' };
  provider: { zdr: true };
};

export type ChatRambleJudgeOptions = {
  client?: OpenAI;
  /** Default: CHAT_MODEL, read per call. */
  model?: string;
};

export function createChatRambleJudge(opts: ChatRambleJudgeOptions = {}): RambleJudge {
  return async (input) => {
    const client = opts.client ?? getOpenRouterClient();
    if (!client) return undefined;
    const model = opts.model ?? config.models.chat;
    const body: OpenRouterJudgeBody = {
      model,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: RAMBLE_SYSTEM_PROMPT },
        { role: 'user', content: buildRambleUserMessage(input) },
      ],
      reasoning: { effort: 'low' },
      // Zero data retention is non-negotiable: this is members' chat, examples included.
      provider: { zdr: true },
    };
    try {
      // The SDK's types know neither `provider` nor OpenRouter's `reasoning` object: bridged here, once.
      const response = await client.chat.completions.create(body as unknown as ChatCompletionCreateParamsNonStreaming, {
        ...featureRequestOptions('ramble'),
        timeout: TIMEOUT_MS,
        maxRetries: 1,
      });
      const choice = response.choices?.[0];
      const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
      const verdict = parseRambleVerdict(text);
      if (!verdict) {
        logger.warn(
          `ramble: ${model} gave no verdict (finish=${choice?.finish_reason ?? 'none'}): ${JSON.stringify(truncate(text, 120))}`,
        );
      }
      return verdict;
    } catch (error) {
      logger.warn(`ramble: ${model} call failed:`, error);
      return undefined;
    }
  };
}
