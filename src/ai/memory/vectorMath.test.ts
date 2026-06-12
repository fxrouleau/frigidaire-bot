import { describe, expect, it } from 'vitest';
import { blobToVector, cosineSimilarity, dot, normalize, vectorToBlob } from './vectorMath';

describe('dot', () => {
  it('computes the dot product', () => {
    expect(dot(new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6]))).toBe(32);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(dot(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
  });

  it('throws on length mismatch', () => {
    expect(() => dot(new Float32Array([1]), new Float32Array([1, 2]))).toThrow(/mismatch/i);
  });

  it('equals cosineSimilarity for normalized vectors', () => {
    const a = normalize(new Float32Array([3, 4, 5]));
    const b = normalize(new Float32Array([1, 2, 3]));
    expect(dot(a, b)).toBeCloseTo(cosineSimilarity(a, b), 6);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it('returns 1 for parallel vectors of different magnitude', () => {
    expect(cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([2, 4, 6]))).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 6);
    expect(cosineSimilarity(new Float32Array([2, 0, 0]), new Float32Array([0, 0, 5]))).toBeCloseTo(0, 6);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([-1, -2]))).toBeCloseTo(-1, 6);
  });

  it('returns 0 when either vector has zero magnitude', () => {
    const zero = new Float32Array([0, 0, 0]);
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(zero, v)).toBe(0);
    expect(cosineSimilarity(v, zero)).toBe(0);
    expect(cosineSimilarity(zero, zero)).toBe(0);
  });

  it('throws on length mismatch', () => {
    expect(() => cosineSimilarity(new Float32Array([1]), new Float32Array([1, 2]))).toThrow(/mismatch/i);
  });
});

describe('normalize', () => {
  it('produces a unit-length vector', () => {
    const n = normalize(new Float32Array([3, 4]));
    expect(n[0]).toBeCloseTo(0.6, 6);
    expect(n[1]).toBeCloseTo(0.8, 6);
    expect(Math.sqrt(dot(n, n))).toBeCloseTo(1, 6);
  });

  it('is idempotent', () => {
    const once = normalize(new Float32Array([1, -2, 3, -4]));
    const twice = normalize(once);
    expect(twice.length).toBe(once.length);
    for (let i = 0; i < once.length; i++) {
      expect(twice[i]).toBeCloseTo(once[i], 6);
    }
  });

  it('does not mutate the input', () => {
    const v = new Float32Array([3, 4]);
    normalize(v);
    expect(Array.from(v)).toEqual([3, 4]);
  });

  it('returns a zero vector for a zero-vector input', () => {
    const n = normalize(new Float32Array([0, 0, 0]));
    expect(Array.from(n)).toEqual([0, 0, 0]);
    expect(n.length).toBe(3);
  });
});

describe('vectorToBlob / blobToVector', () => {
  it('round-trips values and length exactly', () => {
    const v = new Float32Array([1.5, -2.25, 0, 3.75, 100.125]);
    const restored = blobToVector(vectorToBlob(v));
    expect(restored.length).toBe(v.length);
    expect(Array.from(restored)).toEqual(Array.from(v));
  });

  it('produces a blob of byteLength dims * 4 (matches the SQL CHECK constraint)', () => {
    expect(vectorToBlob(new Float32Array(7)).byteLength).toBe(28);
    expect(vectorToBlob(new Float32Array(0)).byteLength).toBe(0);
  });

  it('round-trips a Float32Array that is itself a view at a non-zero offset', () => {
    // A Float32Array view into a larger buffer (byteOffset 4) — vectorToBlob must capture only its bytes.
    const backing = new Float32Array([99, 1.5, -2.5, 3.5]);
    const view = new Float32Array(backing.buffer, 4, 3);
    const blob = vectorToBlob(view);
    expect(blob.byteLength).toBe(12);
    expect(Array.from(blobToVector(blob))).toEqual([1.5, -2.5, 3.5]);
  });

  it('decodes an unaligned Buffer correctly (odd byteOffset, as better-sqlite3 can return)', () => {
    const v = new Float32Array([1.5, -2.25, 3.75]);
    const aligned = vectorToBlob(v);
    // Simulate a Buffer whose view into its backing ArrayBuffer starts at an odd (non-4-aligned) offset.
    const backing = Buffer.alloc(aligned.byteLength + 1);
    aligned.copy(backing, 1);
    const unaligned = backing.subarray(1);
    expect(unaligned.byteOffset % 4).not.toBe(0);

    const restored = blobToVector(unaligned);
    expect(Array.from(restored)).toEqual([1.5, -2.25, 3.75]);
  });

  it('demonstrates the alignment trap blobToVector exists to avoid', () => {
    // The naive zero-copy view over an unaligned Buffer throws — this is why blobToVector copies.
    const aligned = vectorToBlob(new Float32Array([1.5, -2.25, 3.75]));
    const backing = Buffer.alloc(aligned.byteLength + 1);
    aligned.copy(backing, 1);
    const unaligned = backing.subarray(1);
    expect(() => new Float32Array(unaligned.buffer, unaligned.byteOffset, 3)).toThrow();
  });

  it('throws on a blob whose byteLength is not a multiple of 4', () => {
    expect(() => blobToVector(Buffer.alloc(7))).toThrow(/multiple of 4/i);
  });

  it('round-trips an embedding-sized normalized vector with full fidelity', () => {
    const v = normalize(new Float32Array(Array.from({ length: 1024 }, (_, i) => Math.sin(i + 1))));
    const restored = blobToVector(vectorToBlob(v));
    expect(restored.length).toBe(1024);
    expect(Array.from(restored)).toEqual(Array.from(v));
    expect(dot(restored, v)).toBeCloseTo(1, 5);
  });
});
