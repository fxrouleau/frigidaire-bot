// A deterministic, offline EmbeddingProvider for tests: bag-of-words hash vectors.
// Texts sharing words get high cosine similarity; texts with disjoint words get ~0 — which makes
// semantic-gate / dedup / fusion tests meaningful without any API access.
import type { EmbeddingKind, EmbeddingProvider } from '../ai/memory/embeddingProvider';
import { normalize } from '../ai/memory/vectorMath';

export const FAKE_EMBEDDING_DIMS = 128;

// FNV-1a 32-bit hash → dimension index.
function hashWordToDim(word: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    hash ^= word.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % FAKE_EMBEDDING_DIMS;
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  public readonly model: string;
  /** Every embed() input, in call order — lets tests assert on what got embedded and as which kind. */
  public readonly calls: Array<{ texts: string[]; kind: EmbeddingKind }> = [];
  /** When set, every embed() call rejects with this error (simulates an API outage). Clear to recover. */
  public failWith: Error | undefined;

  constructor(model = 'fake-embeddings') {
    this.model = model;
  }

  async embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
    this.calls.push({ texts: [...texts], kind });

    if (this.failWith) {
      throw this.failWith;
    }

    return texts.map((text) => FakeEmbeddingProvider.vectorFor(text));
  }

  /** The deterministic vector embed() would return for a text — usable directly in test assertions. */
  static vectorFor(text: string): Float32Array {
    const vector = new Float32Array(FAKE_EMBEDDING_DIMS);
    // Split on whitespace, then strip punctuation per word (Unicode-aware: letters/digits/underscore
    // survive). This makes 'Felix:' hash like 'Felix' — mirroring how real embedding models tokenize —
    // so subject-prefixed inputs ("Felix: loves pizza") match queries containing the bare subject word.
    const words = text
      .toLowerCase()
      .split(/\s+/)
      .map((word) => word.replace(/[^\p{L}\p{N}_]/gu, ''))
      .filter((word) => word.length > 0);
    for (const word of words) {
      vector[hashWordToDim(word)] += 1;
    }
    return normalize(vector);
  }
}
