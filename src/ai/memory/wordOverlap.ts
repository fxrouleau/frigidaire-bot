const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'am',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'and',
  'or',
  'but',
  'it',
  'he',
  'she',
  'they',
  'his',
  'her',
  'with',
  'from',
  'that',
  'this',
  'have',
  'has',
  'had',
]);

export function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(
    a
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0 && !STOP_WORDS.has(w)),
  );
  const wordsB = new Set(
    b
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0 && !STOP_WORDS.has(w)),
  );

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  const intersection = [...wordsA].filter((w) => wordsB.has(w));
  return intersection.length / Math.max(wordsA.size, wordsB.size);
}
