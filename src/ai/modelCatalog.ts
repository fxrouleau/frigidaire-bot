// One cached view of OpenRouter's public model metadata, shared by everything that sizes or routes a
// request by model:
//   - the chat agent's history budget (context lengths)
//   - the media features (input modalities, and the lowest `reasoning.effort` a model accepts)
//   - the transcription route (which endpoints serve a speech-to-text model, and whether every one of
//     them is on OpenRouter's zero-data-retention list)
//
// Everything here is public metadata (no key, no chat text), fetched with plain fetch():
//   GET /models                     ≈750 KB, once a day
//   GET /endpoints/zdr              ≈800 KB, once a day, only when a ZDR check is asked for
//   GET /models/<id>/endpoints      a few KB per model, once a day
// A failed fetch keeps whatever was loaded before (stale metadata beats none) and is retried after a
// cooldown, never on every call. Under Vitest the shared instance never fetches (hermetic tests).
//
// Why reasoning effort matters to media: models disagree wildly on their default. On 2026-09-25 the
// list had google/gemini-3.5-flash-lite at default 'minimal' but z-ai/glm-5.3-flash at 'max', and
// reasoning is billed as output — for a verbatim transcript, thinking is pure cost and latency.
import { config } from '../config';
import { logger } from '../logger';
import { OPENROUTER_BASE_URL } from './openRouterClient';

export const MODELS_URL = `${OPENROUTER_BASE_URL}/models`;
export const ZDR_ENDPOINTS_URL = `${OPENROUTER_BASE_URL}/endpoints/zdr`;

/** `/models/<author>/<slug>/endpoints`, each path segment escaped. */
export function modelEndpointsUrl(model: string, baseUrl = OPENROUTER_BASE_URL): string {
  return `${baseUrl}/models/${model.split('/').map(encodeURIComponent).join('/')}/endpoints`;
}

const LIST_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
// A ZDR verdict is a privacy decision: past this age without a successful re-check it no longer counts,
// so a long metadata outage fails closed instead of trusting a days-old "every host is ZDR".
const MAX_COVERAGE_STALENESS_MS = 3 * 24 * 60 * 60 * 1000;

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export type ModelInfo = {
  /** e.g. text, image, audio, video, file. */
  inputModalities: ReadonlySet<string>;
  /**
   * The cheapest `reasoning.effort` the model accepts ('none' when reasoning can be switched off);
   * undefined for models without reasoning controls, where no override should be sent.
   */
  lowestEffort?: string;
};

type CatalogEntry = {
  id?: unknown;
  context_length?: unknown;
  architecture?: { input_modalities?: unknown };
  reasoning?: { supported_efforts?: unknown; mandatory?: unknown } | null;
};

type ParsedEntry = { info?: ModelInfo; contextLength?: number };

export type EndpointInfo = { provider: string; tag: string; zdr: boolean };

/** An endpoints listing before it is matched against the ZDR list (`key` = model id + tag). */
type EndpointListing = Omit<EndpointCoverage, 'allZdr' | 'endpoints'> & {
  endpoints: Array<{ provider: string; tag: string; key: string }>;
};

/** Which endpoints serve a model, and whether each is on the ZDR list. */
export type EndpointCoverage = {
  model: string;
  /** False when OpenRouter doesn't know the id at all (404). */
  found: boolean;
  /** 'text' for chat models, 'transcription' for speech-to-text models, … */
  outputModalities: ReadonlySet<string>;
  endpoints: EndpointInfo[];
  /** True when the model has at least one endpoint and every one of them is zero-data-retention. */
  allZdr: boolean;
  /** When the endpoint list was fetched (epoch ms). */
  checkedAt: number;
};

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The lowest effort a model's `reasoning` object allows; efforts are listed highest first. */
export function lowestEffort(reasoning: CatalogEntry['reasoning']): string | undefined {
  if (!reasoning) return undefined;
  const efforts = stringArray(reasoning.supported_efforts);
  // null ⇒ "all gateway effort values are accepted"; 'low' is the floor every reasoning family honors.
  if (!efforts) return 'low';
  // A model with mandatory reasoning rejects 'none'.
  const usable = reasoning.mandatory === true ? efforts.filter((e) => e !== 'none') : efforts;
  return usable.at(-1);
}

export function parseCatalogEntry(entry: CatalogEntry): ModelInfo | undefined {
  const modalities = stringArray(entry.architecture?.input_modalities);
  if (!modalities) return undefined;
  return { inputModalities: new Set(modalities), lowestEffort: lowestEffort(entry.reasoning) };
}

function parseContextLength(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Name-based knowledge for when the catalog is unreachable: Gemini chat models hear audio and watch
 * video; nothing else is assumed. No reasoning override (each model runs at its own default).
 */
export function staticModelInfo(model: string): ModelInfo {
  const id = model.toLowerCase();
  if (id.startsWith('google/gemini') && !id.includes('-image')) {
    return { inputModalities: new Set(['text', 'image', 'audio', 'video']) };
  }
  return { inputModalities: new Set(['text']) };
}

/**
 * The lookup key variants for a model id: the id itself, then (for a variant like `deepseek/x:nitro` or
 * `…:free`) the base id, since the list only carries some variants. `~author/alias-latest` router aliases
 * are not in the list at all and resolve to undefined.
 */
function candidateIds(modelId: string): string[] {
  const colon = modelId.indexOf(':');
  return colon > 0 ? [modelId, modelId.slice(0, colon)] : [modelId];
}

function endpointKey(modelId: string, tag: string): string {
  return `${modelId}\u0000${tag}`;
}

async function withDeadline<T>(promise: Promise<T>, waitMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  try {
    await Promise.race([promise.then(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A daily-refreshed, fail-soft cached value: one in-flight load, a cooldown after failures, stale kept. */
class CachedResource<T> {
  value: T | undefined;
  loadedAt: number | undefined;
  private expiresAt = 0;
  private lastFailureAt: number | undefined;
  private inflight: Promise<void> | undefined;

  constructor(
    private readonly label: string,
    private readonly now: () => number,
    private readonly loader: () => Promise<T>,
  ) {}

  get fresh(): boolean {
    return this.value !== undefined && this.now() < this.expiresAt;
  }

  /** Starts (or joins) a load when the value is missing or stale; undefined when there is nothing to wait for. */
  refresh(): Promise<void> | undefined {
    if (this.fresh) return undefined;
    if (this.inflight) return this.inflight;
    if (this.lastFailureAt !== undefined && this.now() - this.lastFailureAt < RETRY_AFTER_FAILURE_MS) return undefined;

    this.inflight = this.loader()
      .then((value) => {
        this.value = value;
        this.loadedAt = this.now();
        this.expiresAt = this.now() + LIST_TTL_MS;
        this.lastFailureAt = undefined;
      })
      .catch((error: unknown) => {
        this.lastFailureAt = this.now();
        logger.warn(
          `model catalog: could not load ${this.label}${this.value === undefined ? '' : ' (keeping the previous copy)'}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  /** The value, after waiting for a refresh when it is missing or stale. */
  async get(): Promise<T | undefined> {
    await this.refresh();
    return this.value;
  }
}

export type ModelCatalogOptions = {
  fetch?: FetchLike;
  now?: () => number;
  /** Default: OpenRouter's public API. */
  baseUrl?: string;
  /** false ⇒ never fetch: lookups resolve to undefined / the static fallbacks (the offline path). */
  enabled?: boolean;
};

export class ModelCatalog {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly enabled: boolean;
  private readonly models: CachedResource<Map<string, ParsedEntry>>;
  private readonly zdrList: CachedResource<Set<string>>;
  private readonly endpoints = new Map<string, CachedResource<EndpointListing>>();

  constructor(opts: ModelCatalogOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.baseUrl = opts.baseUrl ?? OPENROUTER_BASE_URL;
    this.enabled = opts.enabled ?? true;
    this.models = new CachedResource("OpenRouter's model list", this.now, () => this.fetchModels());
    this.zdrList = new CachedResource("OpenRouter's ZDR endpoint list", this.now, () => this.fetchZdrList());
  }

  // ---- Context lengths (the chat agent's history budget) ----

  /**
   * The model's context length in tokens, or undefined when unknown. Waits at most `waitMs` for the model
   * list; a slower fetch keeps running in the background and serves later calls.
   */
  async contextLength(modelId: string, waitMs = 3000): Promise<number | undefined> {
    if (!this.enabled) return undefined;
    const loading = this.models.refresh();
    if (loading && this.models.value === undefined) await withDeadline(loading, waitMs);
    return this.lookupContextLength(modelId);
  }

  /** Synchronous cache read; undefined until the list has loaded. */
  lookupContextLength(modelId: string): number | undefined {
    return this.lookup(modelId)?.contextLength;
  }

  // ---- Modalities and reasoning effort (the media features) ----

  /** The model's catalog entry; the static fallback when the catalog is unavailable or lacks it. */
  async info(model: string): Promise<ModelInfo> {
    return (await this.catalogInfo(model)) ?? staticModelInfo(model);
  }

  /** Like info(), but undefined when the catalog itself couldn't say (unreachable, or no such id). */
  async catalogInfo(model: string): Promise<ModelInfo | undefined> {
    if (!this.enabled) return undefined;
    await this.models.get();
    return this.lookup(model)?.info;
  }

  // ---- Endpoint coverage (routing-blind endpoints such as speech-to-text) ----

  /**
   * Which endpoints serve `model` and whether every one is on OpenRouter's ZDR list. For endpoints that
   * ignore provider routing (speech-to-text), this is the only way to know a request can't land on a
   * host that keeps the audio. Undefined when it can't be verified right now (metadata unreachable and
   * no recent verdict) — callers must treat that as "not verified".
   */
  async endpointCoverage(model: string): Promise<EndpointCoverage | undefined> {
    if (!this.enabled) return undefined;
    let resource = this.endpoints.get(model);
    if (!resource) {
      resource = new CachedResource(`the endpoints of ${model}`, this.now, () => this.fetchEndpoints(model));
      this.endpoints.set(model, resource);
    }
    const [listing, zdr] = await Promise.all([resource.get(), this.zdrList.get()]);
    if (!listing || !zdr) return undefined;
    if (this.now() - listing.checkedAt > MAX_COVERAGE_STALENESS_MS) return undefined;
    if ((this.zdrList.loadedAt ?? 0) + MAX_COVERAGE_STALENESS_MS < this.now()) return undefined;

    const endpoints = listing.endpoints.map((e) => ({ provider: e.provider, tag: e.tag, zdr: zdr.has(e.key) }));
    return { ...listing, endpoints, allZdr: endpoints.length > 0 && endpoints.every((e) => e.zdr) };
  }

  // ---- Fetching ----

  private lookup(modelId: string): ParsedEntry | undefined {
    const models = this.models.value;
    if (!models) return undefined;
    for (const id of candidateIds(modelId)) {
      const entry = models.get(id);
      if (entry) return entry;
    }
    return undefined;
  }

  private async fetchJson(url: string): Promise<{ status: number; body: unknown }> {
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (response.status === 404) return { status: 404, body: undefined };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { status: response.status, body: (await response.json()) as unknown };
  }

  private async fetchModels(): Promise<Map<string, ParsedEntry>> {
    const { body } = await this.fetchJson(`${this.baseUrl}/models`);
    const data = isRecord(body) ? body.data : undefined;
    if (!Array.isArray(data)) throw new Error('unexpected model list shape (no data array)');

    const models = new Map<string, ParsedEntry>();
    for (const raw of data as CatalogEntry[]) {
      if (!isRecord(raw) || typeof raw.id !== 'string') continue;
      const entry: ParsedEntry = {
        info: parseCatalogEntry(raw),
        contextLength: parseContextLength(raw.context_length),
      };
      if (entry.info || entry.contextLength !== undefined) models.set(raw.id, entry);
    }
    if (models.size === 0) throw new Error('the model list was empty');
    return models;
  }

  private async fetchZdrList(): Promise<Set<string>> {
    const { body } = await this.fetchJson(`${this.baseUrl}/endpoints/zdr`);
    const data = isRecord(body) ? body.data : undefined;
    if (!Array.isArray(data)) throw new Error('unexpected ZDR list shape (no data array)');
    const keys = new Set<string>();
    for (const entry of data) {
      if (isRecord(entry) && typeof entry.model_id === 'string' && typeof entry.tag === 'string') {
        keys.add(endpointKey(entry.model_id, entry.tag));
      }
    }
    if (keys.size === 0) throw new Error('the ZDR list was empty');
    return keys;
  }

  private async fetchEndpoints(model: string): Promise<EndpointListing> {
    const checkedAt = this.now();
    const { status, body } = await this.fetchJson(modelEndpointsUrl(model, this.baseUrl));
    if (status === 404) return { model, found: false, outputModalities: new Set(), endpoints: [], checkedAt };
    const data = isRecord(body) ? body.data : undefined;
    if (!isRecord(data) || !Array.isArray(data.endpoints)) throw new Error('unexpected endpoints shape');

    const architecture = isRecord(data.architecture) ? data.architecture : {};
    // The ZDR list names an endpoint by (model_id, tag), with the model id as the endpoints listing reports it.
    const listedId = typeof data.id === 'string' ? data.id : model;
    const endpoints: EndpointListing['endpoints'] = [];
    for (const entry of data.endpoints) {
      if (!isRecord(entry)) continue;
      // An endpoint without a tag can't be matched against the ZDR list, so it can never count as ZDR.
      const tag = typeof entry.tag === 'string' ? entry.tag : '';
      const provider = typeof entry.provider_name === 'string' ? entry.provider_name : tag || 'unknown';
      const modelId = typeof entry.model_id === 'string' ? entry.model_id : listedId;
      endpoints.push({ provider, tag, key: tag ? endpointKey(modelId, tag) : '' });
    }
    return {
      model: listedId,
      found: true,
      outputModalities: new Set(stringArray(architecture.output_modalities) ?? []),
      endpoints,
      checkedAt,
    };
  }
}

// ---- Shared instance ----

let shared: ModelCatalog | undefined;

/** The process-wide catalog. Under Vitest it never fetches: every lookup takes the offline fallback path. */
export function getModelCatalog(): ModelCatalog {
  shared ??= new ModelCatalog({ enabled: !config.isTest });
  return shared;
}

/** The slice of the catalog the chat agent's history budget reads (injected as a fake in tests). */
export type ModelContextLengths = {
  get(modelId: string, waitMs?: number): Promise<number | undefined>;
  lookup(modelId: string): number | undefined;
};

export function contextLengthsOf(catalog: ModelCatalog): ModelContextLengths {
  return {
    get: (modelId, waitMs) => catalog.contextLength(modelId, waitMs),
    lookup: (modelId) => catalog.lookupContextLength(modelId),
  };
}

export function getModelContextLengths(): ModelContextLengths {
  return contextLengthsOf(getModelCatalog());
}
