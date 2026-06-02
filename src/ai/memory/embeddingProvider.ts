import * as process from 'node:process';
import OpenAI from 'openai';
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

const DEFAULT_EMBEDDING_MODEL = 'qwen/qwen3-embedding-8b';

// Qwen3-Embedding's documented asymmetric-retrieval format: queries carry a task instruction,
// documents are embedded with no prefix at all. Getting this wrong silently costs retrieval quality.
const DEFAULT_QUERY_INSTRUCTION =
  'Given a message from a Discord chat, retrieve stored memories about the people, preferences, events, and server culture that are relevant to it';

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  public readonly model: string;

  private readonly client: OpenAI;
  private readonly routing: Record<string, unknown>;
  private readonly queryInstruction: string;

  constructor(opts: OpenRouterEmbeddingProviderOptions = {}) {
    if (opts.client) {
      this.client = opts.client;
    } else {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY is required');
      }

      this.client = new OpenAI({
        apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'X-Title': 'Frigidaire Bot',
        },
      });
    }

    this.model = opts.model ?? (process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL);
    // ZDR routing is mandatory: memory text is the same private content the chat path protects.
    this.routing = opts.routing ?? { zdr: true };
    this.queryInstruction = process.env.EMBEDDING_QUERY_INSTRUCTION || DEFAULT_QUERY_INSTRUCTION;
  }

  async embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const input = kind === 'query' ? texts.map((text) => this.toQueryInput(text)) : texts;

    const response = await this.client.embeddings.create({
      model: this.model,
      input,
      // Explicit float format: the SDK otherwise defaults to base64 (and decodes it itself), which
      // not every OpenRouter embeddings backend supports and which fixtures couldn't represent readably.
      encoding_format: 'float',
      // @ts-expect-error OpenRouter-specific field
      provider: this.routing,
    });

    const data = response?.data;
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error(`OpenRouter embeddings returned no data for model ${this.model}`);
    }
    if (data.length !== texts.length) {
      throw new Error(`OpenRouter embeddings returned ${data.length} vectors for ${texts.length} inputs`);
    }

    // The API documents data as input-ordered, with an explicit index field — sort by it to be safe.
    const ordered = [...data].sort((a, b) => a.index - b.index);
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
  if (process.env.VITEST) return undefined;

  // Kill switch: SEMANTIC_MEMORY_ENABLED=false/0 reverts to FTS5-only memory with no code rollback.
  const enabled = process.env.SEMANTIC_MEMORY_ENABLED;
  if (enabled === 'false' || enabled === '0') return undefined;

  if (!process.env.OPENROUTER_API_KEY) return undefined;

  return new OpenRouterEmbeddingProvider();
}
