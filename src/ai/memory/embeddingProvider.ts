import type OpenAI from 'openai';
import type { EmbeddingCreateParams } from 'openai/resources/embeddings';
import { config } from '../../config';
import { requireOpenRouterClient } from '../openRouterClient';
import { featureRequestOptions } from '../usage';
import { normalize } from './vectorMath';

/** What the texts will be used for: queries get the model's retrieval instruction prefix, documents do not. */
export type EmbeddingKind = 'query' | 'document';

export interface EmbeddingProvider {
  /** The embedding model id — stored alongside each vector so model switches can be detected. */
  readonly model: string;
  /**
   * Embeds texts in order, returning one L2-normalized Float32Array per input text.
   * Throws on API errors or malformed responses (callers fall back to lexical search).
   */
  embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]>;
}

export type OpenRouterEmbeddingProviderOptions = {
  client?: OpenAI;
  model?: string;
  routing?: Record<string, unknown>;
};

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  public readonly model: string;

  private readonly client: OpenAI;
  private readonly routing: Record<string, unknown>;
  private readonly queryInstruction: string;

  constructor(opts: OpenRouterEmbeddingProviderOptions = {}) {
    this.client = opts.client ?? requireOpenRouterClient('embeddings');
    this.model = opts.model ?? config.models.embedding;
    // ZDR routing is mandatory: memory text is the same private content the chat path protects.
    this.routing = opts.routing ?? { zdr: true };
    this.queryInstruction = config.memory.queryInstruction;
  }

  async embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const input = kind === 'query' ? texts.map((text) => this.toQueryInput(text)) : texts;

    // A typed variable rather than an inline literal: OpenRouter's `provider` routing field is not in the
    // SDK's params type, and only a fresh object literal gets the excess-property check.
    const body: EmbeddingCreateParams & { provider: Record<string, unknown> } = {
      model: this.model,
      input,
      // Explicit float format: the SDK otherwise defaults to base64 (and decodes it itself), which
      // not every OpenRouter embeddings backend supports and which fixtures couldn't represent readably.
      encoding_format: 'float',
      provider: this.routing,
    };
    const response = await this.client.embeddings.create(body, featureRequestOptions('embedding'));

    const data = response?.data;
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error(`OpenRouter embeddings returned no data for model ${this.model}`);
    }
    if (data.length !== texts.length) {
      throw new Error(`OpenRouter embeddings returned ${data.length} vectors for ${texts.length} inputs`);
    }

    // The API documents data as input-ordered, with an explicit index field — sort by it to be safe.
    // Nullish fallback: if a backend ever omits index, every comparison is 0 - 0 and the (stable) sort
    // preserves the response's positional order instead of going implementation-defined on NaN.
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((item) => {
      const embedding = item?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error(`OpenRouter embeddings returned an empty vector for model ${this.model}`);
      }
      return normalize(new Float32Array(embedding));
    });
  }

  private toQueryInput(text: string): string {
    return `Instruct: ${this.queryInstruction}\nQuery: ${text}`;
  }
}

/**
 * Builds the production embedding provider, or undefined when semantic memory should be off.
 * Never throws — undefined simply means MemoryStore runs in FTS5-only mode (pre-semantic behavior).
 */
export function makeDefaultEmbeddingProvider(): EmbeddingProvider | undefined {
  // Test hermeticity guard: never construct a real (paid) provider from inside the Vitest runner.
  // Live tests construct OpenRouterEmbeddingProvider explicitly and are unaffected.
  if (config.isTest) return undefined;

  // Kill switch: SEMANTIC_MEMORY_ENABLED=false/0 reverts to FTS5-only memory with no code rollback.
  if (!config.memory.semanticEnabled) return undefined;

  if (!config.openRouter.apiKey) return undefined;

  return new OpenRouterEmbeddingProvider();
}
