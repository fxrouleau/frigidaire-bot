// OpenRouter's decisions endpoint (POST /api/alpha/decisions). TypeSafe "System One" decision models
// such as typesafe/jev-1.13 answer typed questions about a JSON `state` with calibrated probabilities
// instead of prose: text-only, billed per input token (~$0.04 per million, output is free), and on
// OpenRouter's ZDR endpoint list. Shared by the deleted-message judge, the addressed-to-bot gate and the
// ramble check.
//
// It is not an OpenAI-SDK route, so it is called with fetch and the configured API key, always with
// `provider: { zdr: true }`, and reports its own usage through recordUsage(). The endpoint is alpha and
// has been seen to hang, so every call carries a short timeout and one retry (network errors, timeouts,
// 408/429/5xx). Anything else resolves to undefined: callers decide what "no answer" means, and every
// current caller fails closed.
import { config } from '../config';
import { logger } from '../logger';
import { type UsageEntry, type UsageFeature, recordUsage } from './usage';

export const DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const DECISIONS_TIMEOUT_MS = 6000;
const MAX_ATTEMPTS = 2;

/** The endpoint takes a plain string, or a JSON object/array of structured guidance, for instructions and criteria. */
export type DecisionGuidance = string | string[] | Record<string, unknown>;

export type NoulQuestion = {
  type: 'noul';
  /** The yes/no question, phrased so that a high probability means yes. */
  instructions: DecisionGuidance;
  /** Optional descriptions of what counts as yes and as no; boundary cases go here. */
  criteria?: { true: DecisionGuidance; false: DecisionGuidance };
};

export type DecisionState = string | Record<string, unknown> | unknown[];

export type DecisionsOptions = {
  /** Usage attribution for the cost ledger. */
  feature: UsageFeature;
  fetch?: typeof globalThis.fetch;
  apiKey?: string;
  timeoutMs?: number;
  /** Also handed every usage entry (the eval runner totals its cost); recordUsage() gets it regardless. */
  onUsage?: (entry: UsageEntry) => void;
};

type DecisionsResponseBody = {
  model?: unknown;
  answers?: Record<string, { noul?: unknown } | undefined>;
  usage?: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown };
};

/** TypeSafe decision models are served by the decisions endpoint, never by chat completions. */
export function isDecisionModel(model: string): boolean {
  return model.startsWith('typesafe/') || model.startsWith('~typesafe/');
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text ? `: ${text.slice(0, 200)}` : '';
  } catch {
    return '';
  }
}

function reportUsage(body: DecisionsResponseBody, requestedModel: string, opts: DecisionsOptions): void {
  const usage = body.usage;
  if (!usage) return;
  const entry: UsageEntry = {
    feature: opts.feature,
    // The response names the dated snapshot that served the call (e.g. typesafe/jev-1.13-20260917).
    model: typeof body.model === 'string' ? body.model : requestedModel,
    promptTokens: finiteNumber(usage.input_tokens),
    completionTokens: finiteNumber(usage.output_tokens),
    cost: finiteNumber(usage.cost),
  };
  recordUsage(entry);
  opts.onUsage?.(entry);
}

/**
 * Asks one or more Noul (yes/no) questions about `state` in a single call (the model answers them
 * independently and in parallel). Resolves to each question's probability of "yes", keyed by question
 * id, or undefined when there is no API key or no complete answer could be had within the retry budget.
 */
export async function askNouls<K extends string>(
  model: string,
  state: DecisionState,
  questions: Record<K, NoulQuestion>,
  opts: DecisionsOptions,
): Promise<Record<K, number> | undefined> {
  const apiKey = opts.apiKey ?? config.openRouter.apiKey;
  if (!apiKey) return undefined;
  const fetchImpl = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const tag = `decisions[${opts.feature}]`;
  const keys = Object.keys(questions) as K[];
  const body = JSON.stringify({ model, provider: { zdr: true }, state, questions });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(DECISIONS_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'X-Title': 'Frigidaire Bot' },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DECISIONS_TIMEOUT_MS),
      });
      if (!response.ok) {
        logger.warn(
          `${tag}: ${model} returned HTTP ${response.status} (attempt ${attempt})${await errorDetail(response)}`,
        );
        if (!isRetryable(response.status)) return undefined;
        continue;
      }

      const parsed = (await response.json()) as DecisionsResponseBody;
      reportUsage(parsed, model, opts);

      const answers = {} as Record<K, number>;
      for (const key of keys) {
        const probability = finiteNumber(parsed.answers?.[key]?.noul);
        if (probability === undefined) {
          logger.warn(`${tag}: ${model} returned no usable answer for "${key}"`);
          return undefined;
        }
        answers[key] = probability;
      }
      return answers;
    } catch (error) {
      logger.warn(`${tag}: ${model} call failed (attempt ${attempt}):`, error);
    }
  }
  return undefined;
}

/** Single-question convenience over askNouls(): the probability of "yes", or undefined. */
export async function askNoul(
  model: string,
  state: DecisionState,
  question: NoulQuestion,
  opts: DecisionsOptions,
): Promise<number | undefined> {
  const answers = await askNouls(model, state, { answer: question }, opts);
  return answers?.answer;
}
