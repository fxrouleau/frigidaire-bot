// Live, paid, opt-in tests against the real OpenRouter embeddings API. These are SKIPPED unless both
// RUN_LIVE=1 and OPENROUTER_API_KEY are set, so they never run in CI or normal local runs.
//
// Run them with:
//   sudo docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... test yarn test:live
//
// They make a handful of tiny embedding calls and cost a fraction of a cent per run.
//
// Two of these tests are more than smoke tests:
//  - The ZDR canary: if the default EMBEDDING_MODEL has no Zero-Data-Retention endpoints, every prod
//    embed call would fail (= permanent FTS fallback). That must fail HERE, loudly, not silently in prod.
//  - The calibration test prints the real cosine values the model produces for related / near-duplicate /
//    unrelated memory pairs — the data used to tune MEMORY_RELEVANCE_THRESHOLD (default 0.35) and
//    MEMORY_DEDUP_THRESHOLD (default 0.88). Grep the output for "CALIBRATION".
import { describe, expect, it } from 'vitest';
import { OpenRouterEmbeddingProvider } from './embeddingProvider';
import { cosineSimilarity, dot } from './vectorMath';

const RUN_LIVE = process.env.RUN_LIVE === '1' && !!process.env.OPENROUTER_API_KEY;
const LIVE_TIMEOUT = 60_000;

function l2Norm(v: Float32Array): number {
  return Math.sqrt(dot(v, v));
}

describe.skipIf(!RUN_LIVE)('OpenRouter embeddings live calibration tests (paid, opt-in)', () => {
  it(
    'embeds under provider.zdr=true routing with the default model (ZDR availability canary — not a flake)',
    async () => {
      // No constructor options: this exercises exactly what prod will use — the default model
      // (EMBEDDING_MODEL env or qwen/qwen3-embedding-8b) with the default provider:{zdr:true} routing
      // (the default routing value is pinned by the offline tests in embeddingProvider.test.ts).
      const provider = new OpenRouterEmbeddingProvider();

      let vectors: Float32Array[];
      try {
        vectors = await provider.embed(['Felix: Felix loves pizza and hot dogs'], 'document');
      } catch (error) {
        const original = error instanceof Error ? error.message : String(error);
        throw new Error(
          `No ZDR endpoints for EMBEDDING_MODEL '${provider.model}' — an embed call with provider:{zdr:true} ` +
            'routing failed. If this canary fails, semantic memory can NEVER work in prod (every embed call ' +
            'falls back to FTS). Pick a default model that has ZDR endpoints — see plan: try ' +
            `openai/text-embedding-3-small or baai/bge-m3. Original error: ${original}`,
        );
      }

      expect(vectors).toHaveLength(1);
      expect(vectors[0].length).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT,
  );

  it(
    'returns a finite, unit-norm Float32Array for a document embed',
    async () => {
      const provider = new OpenRouterEmbeddingProvider();
      const [vector] = await provider.embed(['Felix: Felix loves pizza and hot dogs'], 'document');

      // Sizing data for the memory_embeddings table: each vector BLOB is dims * 4 bytes.
      console.log(`CALIBRATION model=${provider.model} dims=${vector.length} blob_bytes=${vector.length * 4}`);

      expect(vector).toBeInstanceOf(Float32Array);
      expect(vector.length).toBeGreaterThan(0);
      expect(vector.every((component) => Number.isFinite(component))).toBe(true);
      // The provider L2-normalizes, so downstream cosine can be computed as a plain dot product.
      expect(Math.abs(l2Norm(vector) - 1)).toBeLessThan(1e-3);
    },
    LIVE_TIMEOUT,
  );

  it(
    'returns batch embeddings in input order',
    async () => {
      const provider = new OpenRouterEmbeddingProvider();
      const texts = [
        'Felix: Felix loves pizza and hot dogs',
        'Jason: Jason mains Yasuo in League of Legends',
        'server culture: movie night happens every Friday',
      ];

      const forward = await provider.embed(texts, 'document');
      const reversed = await provider.embed([...texts].reverse(), 'document');

      expect(forward).toHaveLength(3);
      expect(reversed).toHaveLength(3);

      // forward[i] and reversed[2 - i] embed the SAME text, so their cosine must be ~1 and must beat every
      // cross-text pairing. If either response came back out of input order, these pairings break.
      for (let i = 0; i < texts.length; i++) {
        const samePair = cosineSimilarity(forward[i], reversed[texts.length - 1 - i]);
        expect(samePair).toBeGreaterThan(0.9);
        for (let j = 0; j < texts.length; j++) {
          if (j === texts.length - 1 - i) continue;
          expect(samePair).toBeGreaterThan(cosineSimilarity(forward[i], reversed[j]));
        }
      }
    },
    LIVE_TIMEOUT,
  );

  it(
    'ranks a related document above an unrelated one for a query (asymmetric retrieval)',
    async () => {
      const provider = new OpenRouterEmbeddingProvider();

      const [query] = await provider.embed(['what does felix like to eat'], 'query');
      const [relatedDoc, unrelatedDoc] = await provider.embed(
        ['Felix: Felix loves pizza and hot dogs', 'Jason: Jason mains Yasuo in League of Legends'],
        'document',
      );

      // The query shares almost no exact keywords with the related doc ("like to eat" vs "loves pizza and
      // hot dogs") — precisely the case FTS5 misses and embeddings must catch.
      expect(cosineSimilarity(query, relatedDoc)).toBeGreaterThan(cosineSimilarity(query, unrelatedDoc));
    },
    LIVE_TIMEOUT,
  );

  it(
    'prints cosine calibration values for MEMORY_RELEVANCE_THRESHOLD / MEMORY_DEDUP_THRESHOLD tuning',
    async () => {
      const provider = new OpenRouterEmbeddingProvider();

      const queryText = 'what does felix like to eat';
      const docTexts = [
        'Felix: Felix loves pizza and hot dogs', // 0: related to the query
        'Jason: Jason mains Yasuo in League of Legends', // 1: unrelated to the query
        'Felix loves pizza', // 2: dedup pair anchor
        'Felix really likes pizza', // 3: near-duplicate of 2 (should merge at save time)
        'Felix loves pasta', // 4: related to 2 but a DISTINCT fact (should NOT merge)
        'Felix: Felix went to a restaurant with Jason last week', // 5: marginally related to the query
      ];

      const [query] = await provider.embed([queryText], 'query');
      const docs = await provider.embed(docTexts, 'document');

      // Query vs document cosines → the search gate (MEMORY_RELEVANCE_THRESHOLD, default 0.35).
      const similar = cosineSimilarity(query, docs[0]);
      const dissimilar = cosineSimilarity(query, docs[1]);
      const marginal = cosineSimilarity(query, docs[5]);

      // Document vs document cosines → save/compact dedup (MEMORY_DEDUP_THRESHOLD, default 0.88).
      const nearDuplicate = cosineSimilarity(docs[2], docs[3]);
      const relatedDistinct = cosineSimilarity(docs[2], docs[4]);
      const unrelated = cosineSimilarity(docs[2], docs[1]);

      // Log BEFORE asserting so the calibration data is captured even if a sanity assertion fails.
      const fmt = (n: number) => n.toFixed(4);
      console.log(`CALIBRATION similar=${fmt(similar)} dissimilar=${fmt(dissimilar)}`);
      console.log(`CALIBRATION model=${provider.model}`);
      console.log('CALIBRATION -- query vs document (search gate: MEMORY_RELEVANCE_THRESHOLD, default 0.35) --');
      console.log(`CALIBRATION   query: '${queryText}'`);
      console.log(`CALIBRATION   related          '${docTexts[0]}' -> ${fmt(similar)}`);
      console.log(`CALIBRATION   marginal         '${docTexts[5]}' -> ${fmt(marginal)}`);
      console.log(`CALIBRATION   unrelated        '${docTexts[1]}' -> ${fmt(dissimilar)}`);
      console.log('CALIBRATION   (the relevance threshold should sit between related and unrelated)');
      console.log('CALIBRATION -- document vs document (dedup: MEMORY_DEDUP_THRESHOLD, default 0.88) --');
      console.log(`CALIBRATION   near_duplicate   '${docTexts[2]}' vs '${docTexts[3]}' -> ${fmt(nearDuplicate)}`);
      console.log(`CALIBRATION   related_distinct '${docTexts[2]}' vs '${docTexts[4]}' -> ${fmt(relatedDistinct)}`);
      console.log(`CALIBRATION   unrelated        '${docTexts[2]}' vs '${docTexts[1]}' -> ${fmt(unrelated)}`);
      console.log('CALIBRATION   (the dedup threshold should sit above related_distinct and at/below near_duplicate)');

      // Shape-tolerant sanity only — the exact values vary by model/backend and ARE the calibration output.
      for (const value of [similar, dissimilar, marginal, nearDuplicate, relatedDistinct, unrelated]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(-1.001);
        expect(value).toBeLessThanOrEqual(1.001);
      }
      expect(similar).toBeGreaterThan(dissimilar);
      expect(nearDuplicate).toBeGreaterThan(unrelated);
    },
    LIVE_TIMEOUT,
  );
});
