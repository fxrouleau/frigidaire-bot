// Pure vector math for embedding-based memory retrieval.
// Vectors are Float32Arrays; SQLite stores them as little-endian Float32 BLOBs.

/**
 * Dot product of two equal-length vectors.
 * For L2-normalized vectors this IS the cosine similarity (the hot path in search/dedup).
 */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1].
 * Returns 0 when either vector has zero magnitude (no direction to compare).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const product = dot(a, b);
  const magnitudeA = Math.sqrt(dot(a, a));
  const magnitudeB = Math.sqrt(dot(b, b));
  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  return product / (magnitudeA * magnitudeB);
}

/**
 * Returns a new L2-normalized (unit-length) copy of the vector. The input is never mutated.
 * A zero vector cannot be normalized and comes back as a zero vector of the same length.
 */
export function normalize(v: Float32Array): Float32Array {
  const magnitude = Math.sqrt(dot(v, v));
  const result = new Float32Array(v.length);
  if (magnitude === 0) return result;
  for (let i = 0; i < v.length; i++) {
    result[i] = v[i] / magnitude;
  }
  return result;
}

/**
 * Zero-copy Buffer view over the vector's exact bytes (little-endian Float32), for SQLite BLOB storage.
 * The Buffer shares memory with the input vector — do not mutate either after handing it to SQLite.
 */
export function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * Decodes a SQLite BLOB back into a Float32Array.
 * better-sqlite3 returns Buffers whose byteOffset is rarely 4-byte aligned, so constructing a
 * Float32Array view directly over `b.buffer` would throw (or silently read garbage). Copying the
 * exact byte range into a fresh ArrayBuffer is always aligned and always correct.
 */
export function blobToVector(b: Buffer): Float32Array {
  if (b.byteLength % 4 !== 0) {
    throw new Error(`Invalid vector blob: byteLength ${b.byteLength} is not a multiple of 4`);
  }
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
