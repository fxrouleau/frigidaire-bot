// The shared OpenRouter client's fetch: attributes every call's usage and cost to the feature that
// made it (see src/ai/usage.ts for the ledger).
//
// It must never break or delay a request. Reading and stripping the feature tag is synchronous header
// work; the response is inspected on a clone, in the background, while the caller already reads the
// original; every failure on that path is swallowed and logged at debug. Errors from the request itself
// propagate untouched — the SDK's retry logic depends on seeing them.
import { config } from '../config';
import { logger } from '../logger';
import { FEATURE_HEADER, type TaggedUsageEntry, normalizeFeature, recordTaggedUsage } from './usage';

export type Fetch = typeof globalThis.fetch;

export type UsageTrackingOptions = {
  /** Where usage goes (default: the bot.db ledger). */
  record?: (entry: TaggedUsageEntry) => void;
  /** Default: USAGE_LEDGER_ENABLED. When off, responses are not inspected at all. */
  isEnabled?: () => boolean;
};

// In-flight response inspections, so callers that need the ledger settled (tests, the eval runner's
// per-scenario cost) can wait for them. Each entry removes itself when done.
const pending = new Set<Promise<void>>();

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Wraps `inner` (default: the global fetch) with feature attribution + usage recording. */
export function createUsageTrackingFetch(inner?: Fetch, opts: UsageTrackingOptions = {}): Fetch {
  const send: Fetch = inner ?? ((input, init) => globalThis.fetch(input, init));
  const record = opts.record ?? recordTaggedUsage;
  const isEnabled = opts.isEnabled ?? (() => config.costs.ledgerEnabled);

  return async (input, init) => {
    const tagged = takeFeatureTag(init);
    const response = await send(input, tagged.init);
    if (isEnabled()) inspectInBackground(response, tagged.feature, init?.body, record);
    return response;
  };
}

/**
 * Reads the feature tag featureRequestOptions() put on the request and removes it, so the internal
 * header never leaves the process. Anything unexpected ⇒ the request goes out exactly as given.
 */
function takeFeatureTag(init: RequestInit | undefined): { init: RequestInit | undefined; feature: string } {
  if (!init?.headers) return { init, feature: 'other' };
  try {
    const headers = new Headers(init.headers);
    const tag = headers.get(FEATURE_HEADER);
    if (tag === null) return { init, feature: 'other' };
    headers.delete(FEATURE_HEADER);
    return { init: { ...init, headers }, feature: normalizeFeature(tag) };
  } catch (error) {
    logger.debug('usage: could not read the feature tag; sending the request unchanged:', error);
    return { init, feature: 'other' };
  }
}

function inspectInBackground(
  response: Response,
  feature: string,
  requestBody: RequestInit['body'] | undefined,
  record: (entry: TaggedUsageEntry) => void,
): void {
  let copy: Response;
  try {
    // Only complete JSON bodies carry a usage object: streamed (SSE) responses would have to be
    // buffered to the end, and error responses have no usage.
    if (!response.ok) return;
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) return;
    copy = response.clone();
  } catch (error) {
    logger.debug('usage: could not clone a response for inspection:', error);
    return;
  }

  const task: Promise<void> = copy
    .json()
    .then((body: unknown) => {
      const entry = extractUsage(body, feature, requestBody);
      if (entry) record(entry);
    })
    .catch((error: unknown) => logger.debug('usage: could not record usage from a response:', error))
    .finally(() => {
      pending.delete(task);
    });
  pending.add(task);
}

/**
 * The ledger entry for one OpenRouter response body, or undefined when it carries no usage (errors,
 * model listings, …). Chat completions and embeddings share the shape: top-level `model`, and
 * `usage.{prompt_tokens, completion_tokens?, cost?, is_byok, cost_details.upstream_inference_cost}`.
 * On BYOK calls `cost` is only OpenRouter's fee; the provider bills the upstream cost separately, so
 * both are added to reflect what the call actually cost.
 */
export function extractUsage(
  body: unknown,
  feature: string,
  requestBody?: RequestInit['body'],
): TaggedUsageEntry | undefined {
  if (!isRecord(body) || !isRecord(body.usage)) return undefined;
  const usage = body.usage;

  let cost = finiteNumber(usage.cost);
  if (usage.is_byok === true && isRecord(usage.cost_details)) {
    const upstream = finiteNumber(usage.cost_details.upstream_inference_cost);
    if (upstream !== undefined) cost = (cost ?? 0) + upstream;
  }

  return {
    feature,
    model: nonEmptyString(body.model) ?? modelFromRequest(requestBody) ?? 'unknown',
    // Speech-to-text responses name their token counts input_tokens/output_tokens (and carry no `model`).
    promptTokens: finiteNumber(usage.prompt_tokens) ?? finiteNumber(usage.input_tokens),
    completionTokens: finiteNumber(usage.completion_tokens) ?? finiteNumber(usage.output_tokens),
    cost,
  };
}

function modelFromRequest(body: RequestInit['body'] | undefined): string | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? nonEmptyString(parsed.model) : undefined;
  } catch {
    return undefined;
  }
}

/** Resolves once every in-flight response inspection has settled. */
export async function flushPendingUsage(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}
