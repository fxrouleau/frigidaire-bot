// What the configured media models can take and how little they can be made to think, read from
// OpenRouter's public model metadata (GET /models: `architecture.input_modalities` and the `reasoning`
// object) instead of hardcoded model-name checks, so swapping TRANSCRIPTION_MODEL / VIDEO_MODEL needs
// no code change.
//
// Why reasoning matters here: models disagree wildly on their default effort. On 2026-09-25 the
// catalog listed google/gemini-3.5-flash-lite at default 'minimal' but z-ai/glm-5.3-flash at 'max',
// and reasoning is billed as output tokens — for a verbatim transcript, thinking is pure cost and
// latency. Sending one fixed effort would raise Flash-Lite's cost while barely helping GLM's.
//
// The catalog is one ~750 KB request per day, shared by every media call. When it can't be fetched,
// callers fall back to name-based defaults (see staticModelInfo) and send no reasoning override.
import type OpenAI from 'openai';
import { config } from '../../config';
import { logger } from '../../logger';
import { getOpenRouterClient } from '../openRouterClient';
import { featureRequestOptions } from '../usage';

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
  architecture?: { input_modalities?: unknown };
  reasoning?: { supported_efforts?: unknown; mandatory?: unknown } | null;
};

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
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

export type ModelCatalogOptions = {
  client?: () => OpenAI | undefined;
  now?: () => number;
};

export class ModelCatalog {
  private readonly client: () => OpenAI | undefined;
  private readonly now: () => number;
  private models: Map<string, ModelInfo> | undefined;
  private expiresAt = 0;
  private loading: Promise<void> | undefined;

  constructor(opts: ModelCatalogOptions = {}) {
    this.client = opts.client ?? getOpenRouterClient;
    this.now = opts.now ?? (() => Date.now());
  }

  /** The model's catalog entry; the static fallback when the catalog is unavailable or lacks it. */
  async info(model: string): Promise<ModelInfo> {
    const models = await this.load();
    return lookup(models, model) ?? staticModelInfo(model);
  }

  /** Like info(), but undefined when the catalog itself couldn't say (unreachable, or no such id). */
  async catalogInfo(model: string): Promise<ModelInfo | undefined> {
    return lookup(await this.load(), model);
  }

  private async load(): Promise<Map<string, ModelInfo> | undefined> {
    if (this.now() < this.expiresAt) return this.models;
    if (!this.loading) {
      this.loading = this.refresh().finally(() => {
        this.loading = undefined;
      });
    }
    await this.loading;
    return this.models;
  }

  private async refresh(): Promise<void> {
    const client = this.client();
    if (!client) {
      this.expiresAt = this.now() + RETRY_AFTER_FAILURE_MS;
      return;
    }
    try {
      // Metadata only — no member content leaves the bot here, so there is nothing for ZDR to cover.
      const response = await client.get<{ data?: unknown }>('/models', {
        ...featureRequestOptions('other'),
        timeout: FETCH_TIMEOUT_MS,
        maxRetries: 1,
      });
      const entries = Array.isArray(response.data) ? (response.data as CatalogEntry[]) : [];
      const models = new Map<string, ModelInfo>();
      for (const entry of entries) {
        const info = typeof entry.id === 'string' ? parseCatalogEntry(entry) : undefined;
        if (info) models.set(String(entry.id), info);
      }
      if (models.size === 0) throw new Error('the model list was empty');
      this.models = models;
      this.expiresAt = this.now() + CATALOG_TTL_MS;
    } catch (error) {
      // Keep whatever was loaded before: stale metadata beats none.
      logger.warn('media: could not load the OpenRouter model catalog; using built-in defaults:', error);
      this.expiresAt = this.now() + RETRY_AFTER_FAILURE_MS;
    }
  }
}

function lookup(models: Map<string, ModelInfo> | undefined, model: string): ModelInfo | undefined {
  if (!models) return undefined;
  // Routing suffixes (':nitro', ':floor') aren't separate catalog entries; ':batch' / ':free' are.
  return models.get(model) ?? models.get(model.replace(/:[a-z-]+$/i, ''));
}

let shared: ModelCatalog | undefined;

export function getModelCatalog(): ModelCatalog {
  // Hermetic under Vitest, like the other shared media instances (see index.ts).
  if (!shared) shared = new ModelCatalog({ client: () => (config.isTest ? undefined : getOpenRouterClient()) });
  return shared;
}
