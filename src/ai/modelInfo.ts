// Context-window sizes of OpenRouter models, read from the public model list
// (GET https://openrouter.ai/api/v1/models → data[].context_length). The chat agent sizes its in-window
// history budget from it. The list is public metadata (no chat text, no key), fetched once per process
// and cached; a failed fetch is retried only after a cooldown, and callers never wait on it for more
// than a few seconds — a turn falls back to CHAT_CONTEXT_TOKENS instead.
import { config } from '../config';
import { logger } from '../logger';
import { OPENROUTER_BASE_URL } from './openRouterClient';

export const MODELS_URL = `${OPENROUTER_BASE_URL}/models`;
const FETCH_TIMEOUT_MS = 15_000;
const RETRY_COOLDOWN_MS = 10 * 60 * 1000;

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export type ModelInfoDeps = {
  fetch?: FetchLike;
  now?: () => number;
  url?: string;
  /** false ⇒ never fetch; every model resolves to undefined (the offline fallback). */
  enabled?: boolean;
};

type ModelListing = { data?: Array<{ id?: unknown; context_length?: unknown }> };

/**
 * The lookup key variants for a model id: the id itself, then (for a variant like `deepseek/x:nitro` or
 * `…:free`) the base id, since the list only carries some variants. `~author/alias-latest` router aliases
 * are not in the list at all and resolve to undefined.
 */
function candidateIds(modelId: string): string[] {
  const colon = modelId.indexOf(':');
  return colon > 0 ? [modelId, modelId.slice(0, colon)] : [modelId];
}

export class ModelContextLengths {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly url: string;
  private readonly enabled: boolean;
  private lengths: Map<string, number> | undefined;
  private inflight: Promise<void> | undefined;
  private lastFailureAt: number | undefined;

  constructor(deps: ModelInfoDeps = {}) {
    this.fetchImpl = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = deps.now ?? Date.now;
    this.url = deps.url ?? MODELS_URL;
    this.enabled = deps.enabled ?? true;
  }

  /**
   * The model's context length in tokens, or undefined when unknown. Waits at most `waitMs` for the model
   * list; a slower fetch keeps running in the background and serves later calls.
   */
  async get(modelId: string, waitMs = 3000): Promise<number | undefined> {
    if (!this.enabled) return undefined;
    if (!this.lengths) {
      const loading = this.load();
      if (loading) {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        });
        await Promise.race([loading, timeout]);
        if (timer) clearTimeout(timer);
      }
    }
    return this.lookup(modelId);
  }

  /** Synchronous cache read; undefined until the list has loaded. */
  lookup(modelId: string): number | undefined {
    if (!this.lengths) return undefined;
    for (const id of candidateIds(modelId)) {
      const length = this.lengths.get(id);
      if (length !== undefined) return length;
    }
    return undefined;
  }

  /** Starts (or joins) the list fetch; undefined while a recent failure's cooldown is running. */
  private load(): Promise<void> | undefined {
    if (this.inflight) return this.inflight;
    if (this.lastFailureAt !== undefined && this.now() - this.lastFailureAt < RETRY_COOLDOWN_MS) return undefined;

    this.inflight = this.fetchList()
      .then((lengths) => {
        this.lengths = lengths;
        this.lastFailureAt = undefined;
      })
      .catch((error: unknown) => {
        this.lastFailureAt = this.now();
        logger.warn(
          `Could not load OpenRouter model context lengths (using CHAT_CONTEXT_TOKENS): ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  private async fetchList(): Promise<Map<string, number>> {
    const response = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as ModelListing;
    if (!Array.isArray(body.data)) throw new Error('unexpected model list shape (no data array)');

    const lengths = new Map<string, number>();
    for (const model of body.data) {
      const length = model.context_length;
      if (typeof model.id === 'string' && typeof length === 'number' && Number.isFinite(length) && length > 0) {
        lengths.set(model.id, length);
      }
    }
    if (lengths.size === 0) throw new Error('model list carried no context lengths');
    return lengths;
  }
}

let shared: ModelContextLengths | undefined;

/**
 * The process-wide lookup. Under Vitest it never fetches (hermetic tests): it resolves every model to
 * undefined, which is exactly the offline fallback path.
 */
export function getModelContextLengths(): ModelContextLengths {
  if (!shared) {
    shared = new ModelContextLengths({ enabled: !config.isTest });
  }
  return shared;
}
