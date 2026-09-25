// "Was this deleted message edgy?" — a yes/no judge with two backends:
//
//   - a TypeSafe "System One" decision model (typesafe/jev-1.13 by default): text-only, returns a
//     calibrated probability instead of prose, costs ~1/100th of a cent per call, and is served
//     through OpenRouter's decisions endpoint (which is on OpenRouter's ZDR list). The endpoint is
//     alpha and has been seen to hang, so calls carry a short timeout and one retry.
//   - any chat model: used when DELETE_REPOST_MODEL names a chat model, and as the fallback (CHAT_MODEL)
//     when the decision model fails or the message is image-only (the decision model can't see images).
//
// The decisions call itself (timeout, retry, ZDR, usage) is shared: see decisions.ts.
import type OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';
import { askNouls, isDecisionModel } from './decisions';
import { getOpenRouterClient } from './openRouterClient';
import { featureRequestOptions } from './usage';

// Re-exported: the decisions call itself lives in decisions.ts, shared with the gate and ramble check.
export { DECISIONS_ENDPOINT, isDecisionModel } from './decisions';

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

const DEFAULT_THRESHOLD = 0.6;

const EDGY_CRITERIA = {
  true: 'Crude, dark, sexual, NSFW, insulting, slurs, politically or religiously charged, provocative, targeted mockery, or anything the author would plausibly delete out of regret or fear of consequences.',
  false: 'Ordinary chat, typos, accidental sends, duplicate posts, logistics, links, harmless jokes.',
};

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
  const answers = await askNouls(
    model,
    {
      author: input.author,
      message: input.text,
      attachments:
        input.attachmentNames.length > 0
          ? `${input.attachmentNames.length} attachment(s): ${input.attachmentNames.join(', ')}`
          : 'none',
    },
    {
      edgy: {
        type: 'noul',
        instructions:
          'Is `message`, posted by `author` in a private Discord server between close friends, edgy — the kind of message the author would delete right after posting?',
        criteria: EDGY_CRITERIA,
      },
    },
    { feature: 'judge', fetch: opts.fetch, apiKey: opts.apiKey },
  );
  if (!answers) return undefined;
  const probability = answers.edgy;
  logger.info(`messageJudge: ${model} says edgy=${probability.toFixed(2)}`);
  return probability >= (opts.threshold ?? DEFAULT_THRESHOLD);
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
    const response = await client.chat.completions.create(
      {
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
      },
      featureRequestOptions('judge'),
    );
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
