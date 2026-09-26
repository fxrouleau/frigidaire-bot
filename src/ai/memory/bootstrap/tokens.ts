// Token estimates for the memory bootstrap (export manifest, chunk sizes, cost estimates). There is no
// tokenizer in the bot: the archive is chat text (short words, slang, emoji, French mixed in), estimated at
// the history budget's 3.5 ASCII characters per token plus one token per other code point (accented
// letters, emoji and CJK split into at least one token each). It errs on the high side, which is the
// right side for a cost estimate.
import { CHARS_PER_TOKEN } from '../../historyBudget';

/** Estimated tokens of `text`. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / CHARS_PER_TOKEN + other);
}

/** "12,345" (thousands separators, for manifests and CLI output). */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** "1 person", "3 people", "12,345 messages": a count with its noun (the plural is the noun + "s" unless given). */
export function counted(n: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : plural}`;
}

/** "$1.23", or "$0.0042" below a cent. */
export function formatUsd(usd: number): string {
  return usd >= 0.01 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toPrecision(2)}`;
}
