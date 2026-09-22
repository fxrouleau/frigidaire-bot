// "Was this deleted message edgy?" — a yes/no judge with two backends:
//
//   - a TypeSafe "System One" decision model (typesafe/jev-1.13 by default): text-only, returns a
//     calibrated probability instead of prose, costs ~1/100th of a cent per call, and is served
//     through OpenRouter's decisions endpoint (which is on OpenRouter's ZDR list). The endpoint is
//     alpha and has been seen to hang, so calls carry a short timeout and one retry.
//   - any chat model (the configured chat model by default): used when DELETE_REPOST_MODEL names a
//     chat model, and as the fallback when the decision model fails or the message is image-only
//     (the decision model can't see images).
import type OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';
import { getOpenRouterClient } from './openRouterClient';

export type JudgeInput = {
  author: string;
  text: string;
  imageUrls: string[];
  attachmentNames: string[];
};

/** Resolves to the verdict, or undefined when no backend could produce one. */
export type MessageJudge = (input: JudgeInput) => Promise<boolean | undefined>;

export type EdgyJudgeOptions = {
  model?: string;
  fallbackModel?: string;
  client?: OpenAI;
  fetch?: typeof globalThis.fetch;
  apiKey?: string;
  /** Probability at/above which a decision-model answer counts as "edgy". */
  threshold?: number;
};

export const DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const DECISIONS_TIMEOUT_MS = 6000;
const DEFAULT_THRESHOLD = 0.6;

const EDGY_CRITERIA = {
  true: 'Crude, dark, sexual, NSFW, insulting, slurs, politically or religiously charged, provocative, targeted mockery, or anything the author would plausibly delete out of regret or fear of consequences.',
  false: 'Ordinary chat, typos, accidental sends, duplicate posts, logistics, links, harmless jokes.',
};

export function isDecisionModel(model: string): boolean {
  return model.startsWith('typesafe/');
}

export function createEdgyJudge(opts: EdgyJudgeOptions = {}): MessageJudge {
  return async (input) => {
    const model = opts.model ?? config.models.messageJudge;
    if (isDecisionModel(model)) {
      if (input.text.trim().length > 0) {
        const verdict = await judgeWithDecisions(model, input, opts);
        if (verdict !== undefined) return verdict;
      }
      return judgeWithChat(opts.fallbackModel ?? config.models.chat, input, opts);
    }
    return judgeWithChat(model, input, opts);
  };
}

async function judgeWithDecisions(
  model: string,
  input: JudgeInput,
  opts: EdgyJudgeOptions,
): Promise<boolean | undefined> {
  const apiKey = opts.apiKey ?? config.openRouter.apiKey;
  if (!apiKey) return undefined;
  const fetchImpl = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));

  const body = JSON.stringify({
    model,
    provider: { zdr: true },
    state: {
      author: input.author,
      message: input.text,
      attachments:
        input.attachmentNames.length > 0
          ? `${input.attachmentNames.length} attachment(s): ${input.attachmentNames.join(', ')}`
          : 'none',
    },
    questions: {
      edgy: {
        type: 'noul',
        instructions:
          'Is `message`, posted by `author` in a private Discord server between close friends, edgy — the kind of message the author would delete right after posting?',
        criteria: EDGY_CRITERIA,
      },
    },
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(DECISIONS_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'X-Title': 'Frigidaire Bot' },
        body,
        signal: AbortSignal.timeout(DECISIONS_TIMEOUT_MS),
      });
      if (!response.ok) {
        logger.warn(`messageJudge: decisions endpoint returned HTTP ${response.status} (attempt ${attempt + 1})`);
        if (response.status < 500 && response.status !== 429) return undefined;
        continue;
      }
      const parsed = (await response.json()) as { answers?: { edgy?: { noul?: unknown } } };
      const probability = parsed.answers?.edgy?.noul;
      if (typeof probability !== 'number' || !Number.isFinite(probability)) {
        logger.warn('messageJudge: decisions endpoint returned no usable answer');
        return undefined;
      }
      logger.info(`messageJudge: ${model} says edgy=${probability.toFixed(2)}`);
      return probability >= (opts.threshold ?? DEFAULT_THRESHOLD);
    } catch (error) {
      logger.warn(`messageJudge: decisions call failed (attempt ${attempt + 1}):`, error);
    }
  }
  return undefined;
}

async function judgeWithChat(model: string, input: JudgeInput, opts: EdgyJudgeOptions): Promise<boolean | undefined> {
  const client = opts.client ?? getOpenRouterClient();
  if (!client) return undefined;

  const content: OpenAI.ChatCompletionContentPart[] = [
    {
      type: 'text',
      text: `Message posted by ${input.author}, then deleted by them right away:\n${input.text || '(no text)'}${
        input.attachmentNames.length > 0 ? `\nAttachments: ${input.attachmentNames.join(', ')}` : ''
      }`,
    },
    ...input.imageUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
  ];

  try {
    const response = await client.chat.completions.create({
      model,
      max_tokens: 20,
      temperature: 0,
      // @ts-expect-error OpenRouter-specific field
      provider: { zdr: true },
      messages: [
        {
          role: 'system',
          content: `You judge messages from a private Discord server between close friends. Decide whether a message is "edgy": ${EDGY_CRITERIA.true} Not edgy: ${EDGY_CRITERIA.false} Answer with JSON only: {"edgy": true} or {"edgy": false}.`,
        },
        { role: 'user', content },
      ],
    });
    const text = response.choices?.[0]?.message?.content ?? '';
    const match = text.match(/"edgy"\s*:\s*(true|false)/i);
    if (!match) {
      logger.warn(`messageJudge: ${model} returned no verdict: ${text.slice(0, 120)}`);
      return undefined;
    }
    const verdict = match[1].toLowerCase() === 'true';
    logger.info(`messageJudge: ${model} says edgy=${verdict}`);
    return verdict;
  } catch (error) {
    logger.warn(`messageJudge: ${model} call failed:`, error);
    return undefined;
  }
}
