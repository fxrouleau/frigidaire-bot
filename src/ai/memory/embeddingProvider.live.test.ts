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
//    MEMORY_DEDUP_THRESHOLD (default 0.88). It repeats the same measurements on MRL-truncated copies of
//    the fetched vectors (2048 / 1024 dims, no extra API calls) to see whether qwen3's Matryoshka
//    truncation preserves related/unrelated separation — if it does, a follow-up can add
//    EMBEDDING_DIMENSIONS support for a 4x storage/compute cut. Grep the output for "CALIBRATION".
import { describe, expect, it } from 'vitest';
import { OpenRouterEmbeddingProvider } from './embeddingProvider';
import { cosineSimilarity, dot, normalize } from './vectorMath';

const RUN_LIVE = process.env.RUN_LIVE === '1' && !!process.env.OPENROUTER_API_KEY;
const LIVE_TIMEOUT = 60_000;

// MRL (Matryoshka) truncation levels to measure alongside the model's full dimensionality.
// Levels >= the full dimensionality are skipped automatically (e.g. when EMBEDDING_MODEL is a small model).
const MRL_TRUNCATION_DIMS = [2048, 1024];

function l2Norm(v: Float32Array): number {
  return Math.sqrt(dot(v, v));
}

/** Client-side MRL truncation: keep the first `dims` components and L2-renormalize. */
function truncate(v: Float32Array, dims: number): Float32Array {
  if (dims >= v.length) return v;
  return normalize(v.slice(0, dims));
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
    'prints cosine calibration values at full and MRL-truncated dims for threshold tuning',
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

      // The same cosine pairs, computed from (possibly MRL-truncated) copies of the fetched vectors.
      //   query vs document    → the search gate (MEMORY_RELEVANCE_THRESHOLD, default 0.35)
      //   document vs document → save/compact dedup (MEMORY_DEDUP_THRESHOLD, default 0.88)
      const measurePairs = (dims: number) => {
        const q = truncate(query, dims);
        const d = docs.map((doc) => truncate(doc, dims));
        return {
          similar: cosineSimilarity(q, d[0]),
          marginal: cosineSimilarity(q, d[5]),
          dissimilar: cosineSimilarity(q, d[1]),
          nearDuplicate: cosineSimilarity(d[2], d[3]),
          relatedDistinct: cosineSimilarity(d[2], d[4]),
          unrelated: cosineSimilarity(d[2], d[1]),
        };
      };

      // Full dims first, then each MRL truncation level smaller than the full vector — measures whether
      // Matryoshka truncation preserves the related/unrelated separation (no extra API calls).
      const dimLevels = [query.length, ...MRL_TRUNCATION_DIMS.filter((dims) => dims < query.length)];
      const measurements = dimLevels.map((dims) => ({ dims, pairs: measurePairs(dims) }));
      const [fullMeasurement] = measurements;

      // Log BEFORE asserting so the calibration data is captured even if a sanity assertion fails.
      const fmt = (n: number) => n.toFixed(4);
      const full = fullMeasurement.pairs;
      console.log(`CALIBRATION similar=${fmt(full.similar)} dissimilar=${fmt(full.dissimilar)}`);
      console.log(`CALIBRATION model=${provider.model} full_dims=${query.length}`);
      console.log(`CALIBRATION query: '${queryText}'`);
      console.log(`CALIBRATION   related   '${docTexts[0]}'`);
      console.log(`CALIBRATION   marginal  '${docTexts[5]}'`);
      console.log(`CALIBRATION   unrelated '${docTexts[1]}'`);
      console.log(`CALIBRATION dedup anchor: '${docTexts[2]}'`);
      console.log(`CALIBRATION   near_duplicate   '${docTexts[3]}'`);
      console.log(`CALIBRATION   related_distinct '${docTexts[4]}'`);
      for (const { dims, pairs } of measurements) {
        console.log(
          `CALIBRATION[${dims}] query-doc (gate, default 0.35): similar=${fmt(pairs.similar)} ` +
            `marginal=${fmt(pairs.marginal)} dissimilar=${fmt(pairs.dissimilar)} ` +
            `separation=${fmt(pairs.similar - pairs.dissimilar)}`,
        );
        console.log(
          `CALIBRATION[${dims}] doc-doc (dedup, default 0.88): near_duplicate=${fmt(pairs.nearDuplicate)} ` +
            `related_distinct=${fmt(pairs.relatedDistinct)} unrelated=${fmt(pairs.unrelated)} ` +
            `separation=${fmt(pairs.nearDuplicate - pairs.relatedDistinct)}`,
        );
      }
      console.log('CALIBRATION the gate threshold should sit between similar and dissimilar; the dedup threshold');
      console.log('CALIBRATION above related_distinct and at/below near_duplicate. If separation holds (does not');
      console.log('CALIBRATION shrink) at 2048/1024, EMBEDDING_DIMENSIONS truncation is viable (4x storage cut).');

      // Shape-tolerant sanity only — the exact values vary by model/backend and ARE the calibration output.
      // Cosines must be valid at every dim level, but ordering is asserted ONLY at full dims: whether MRL
      // truncation preserves the ordering/separation is exactly the open question being measured.
      for (const { pairs } of measurements) {
        for (const value of Object.values(pairs)) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(-1.001);
          expect(value).toBeLessThanOrEqual(1.001);
        }
      }
      expect(full.similar).toBeGreaterThan(full.dissimilar);
      expect(full.nearDuplicate).toBeGreaterThan(full.unrelated);
    },
    LIVE_TIMEOUT,
  );
});
