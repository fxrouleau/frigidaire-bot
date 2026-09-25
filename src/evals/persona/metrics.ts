// Deterministic reply metrics and the scenario's hard expectations. Cheap, reproducible signals that sit
// next to the judge's scores: a model that "sounds right" to the judge but writes 900-character replies
// to "good morning" still shows up here.
import type { Expectations } from './scenarioFile';

export type ReplyMetrics = {
  chars: number;
  sentences: number;
  customEmojis: number;
  unicodeEmojis: number;
  /** The reply opens by addressing the speaker by name (the persona says not to). */
  startsWithName: boolean;
  /** Labels of assistant-speak / disclaimer tells found in the reply. */
  styleTells: string[];
};

export type CheckResult = { name: string; passed: boolean; detail: string };

const CUSTOM_EMOJI = /<a?:\w+:\d+>/g;
const UNICODE_EMOJI = /\p{Extended_Pictographic}/gu;

// Phrases that mark a reply as an assistant talking, or as a lecture. Deliberately narrow: each one is
// something the persona prompt explicitly rules out, so a hit is a real regression, not a style opinion.
const STYLE_TELLS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'as-an-ai', pattern: /\bas an ai\b|\blanguage model\b|\bi'?m (just )?(an? )?(ai|bot)\b/i },
  { label: 'cant-help', pattern: /\bi (can'?t|cannot|won'?t) (help|assist) with\b/i },
  { label: 'important-to', pattern: /\bit'?s (important|worth) (to )?(remember|note|noting)\b/i },
  { label: 'keep-it-respectful', pattern: /\b(let'?s|please) (keep it|be) (respectful|kind|civil)\b/i },
  { label: 'happy-to-help', pattern: /\b(i'?d be|i'?m) (happy|glad) to help\b|\bgreat question\b/i },
  { label: 'let-me-know', pattern: /\b(let me know|feel free to ask) if (you|there)\b/i },
];

export function countSentences(text: string): number {
  const cleaned = text
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(CUSTOM_EMOJI, ' ')
    .trim();
  if (cleaned.length === 0) return 0;
  return cleaned.split(/(?<=[.!?…])\s+|\n+/).filter((piece) => /[\p{L}\p{N}]/u.test(piece)).length;
}

export function measureReply(reply: string, speakerNames: string[]): ReplyMetrics {
  const trimmed = reply.trim();
  const lowered = trimmed.toLowerCase().replace(/^@/, '');
  return {
    chars: trimmed.length,
    sentences: countSentences(trimmed),
    customEmojis: trimmed.match(CUSTOM_EMOJI)?.length ?? 0,
    unicodeEmojis: trimmed.match(UNICODE_EMOJI)?.length ?? 0,
    startsWithName: speakerNames.some((name) => {
      const lower = name.toLowerCase();
      return lowered.startsWith(lower) && !/[\p{L}\p{N}]/u.test(lowered.charAt(lower.length));
    }),
    styleTells: STYLE_TELLS.filter((tell) => tell.pattern.test(trimmed)).map((tell) => tell.label),
  };
}

function check(name: string, passed: boolean, detail: string): CheckResult {
  return { name, passed, detail };
}

/**
 * The scenario's hard expectations plus the persona's universal rules. `activeMemories` are the
 * store's "subject: content" lines after the turn (only needed when the scenario checks memory).
 */
export function checkExpectations(
  reply: string,
  metrics: ReplyMetrics,
  expectations: Expectations,
  activeMemories: string[] = [],
): CheckResult[] {
  const results: CheckResult[] = [
    check('replied', reply.trim().length > 0, reply.trim().length > 0 ? 'non-empty reply' : 'no reply'),
    check(
      'no-style-tells',
      metrics.styleTells.length === 0,
      metrics.styleTells.length === 0 ? 'none' : metrics.styleTells.join(', '),
    ),
    check('no-name-opener', !metrics.startsWithName, metrics.startsWithName ? "opens with the speaker's name" : 'ok'),
    check(
      'max-custom-emojis',
      metrics.customEmojis <= expectations.maxCustomEmojis,
      `${metrics.customEmojis} (max ${expectations.maxCustomEmojis})`,
    ),
  ];

  if (expectations.maxChars !== undefined) {
    results.push(
      check('max-chars', metrics.chars <= expectations.maxChars, `${metrics.chars} (max ${expectations.maxChars})`),
    );
  }
  if (expectations.minChars !== undefined) {
    results.push(
      check('min-chars', metrics.chars >= expectations.minChars, `${metrics.chars} (min ${expectations.minChars})`),
    );
  }
  if (expectations.maxSentences !== undefined) {
    results.push(
      check(
        'max-sentences',
        metrics.sentences <= expectations.maxSentences,
        `${metrics.sentences} (max ${expectations.maxSentences})`,
      ),
    );
  }
  for (const source of expectations.mustMatch) {
    const passed = new RegExp(source, 'i').test(reply);
    results.push(check(`must-match /${source}/`, passed, passed ? 'matched' : 'no match'));
  }
  for (const source of expectations.mustNotMatch) {
    const hit = reply.match(new RegExp(source, 'i'))?.[0];
    results.push(check(`must-not-match /${source}/`, hit === undefined, hit === undefined ? 'ok' : `found "${hit}"`));
  }
  if (expectations.memoryAfter) {
    for (const source of expectations.memoryAfter.activeMustMatch) {
      const pattern = new RegExp(source, 'i');
      const found = activeMemories.find((line) => pattern.test(line));
      results.push(check(`memory-has /${source}/`, found !== undefined, found ?? 'no active memory matches'));
    }
    for (const source of expectations.memoryAfter.activeMustNotMatch) {
      const pattern = new RegExp(source, 'i');
      const found = activeMemories.find((line) => pattern.test(line));
      results.push(check(`memory-lacks /${source}/`, found === undefined, found ?? 'ok'));
    }
  }
  return results;
}
