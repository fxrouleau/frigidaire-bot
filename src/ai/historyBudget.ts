// Bounds a conversation window's history by an estimated token budget.
//
// Estimates, not tokenizer counts: text ≈ chars / 3.5 and a flat cost per image part (vision models
// bill images by resolution, and the provider downsizes every image to ≤1568px, so ~1.5k is a
// reasonable ceiling). The budget is a fraction of the model's context, so a rough estimate is enough.
//
// Trimming runs when a turn's state is persisted, rarely: once over budget it cuts down to 75% so the
// next several turns fit without touching the (provider-cached) prefix again.
import type { ConversationEntry } from './types';

export const CHARS_PER_TOKEN = 3.5;
export const IMAGE_PART_TOKENS = 1500;
/** Upper bound on any history budget, however large the model's context is. */
export const MAX_HISTORY_TOKENS = 500_000;
/** After trimming, history is brought down to this fraction of the budget. */
export const TRIM_TARGET_RATIO = 0.75;
export const TRIMMED_NOTE = '[Older messages in this conversation were trimmed]';
export const IMAGE_PLACEHOLDER = '[image]';

/** The history budget: an explicit override, else min(500k, half the model's context window). */
export function historyBudgetFor(contextTokens: number, override?: number): number {
  if (override !== undefined) return override;
  return Math.min(MAX_HISTORY_TOKENS, Math.floor(contextTokens * 0.5));
}

export function estimateEntryTokens(entry: ConversationEntry): number {
  switch (entry.kind) {
    case 'tool_call':
      return Math.ceil((entry.name.length + JSON.stringify(entry.arguments).length) / CHARS_PER_TOKEN);
    case 'tool_result':
      return Math.ceil(entry.content.length / CHARS_PER_TOKEN);
    case 'message': {
      let tokens = 0;
      for (const part of entry.content) {
        tokens += part.type === 'image' ? IMAGE_PART_TOKENS : Math.ceil(part.text.length / CHARS_PER_TOKEN);
      }
      return tokens;
    }
  }
}

export function estimateTokens(entries: ConversationEntry[]): number {
  let total = 0;
  for (const entry of entries) total += estimateEntryTokens(entry);
  return total;
}

export type TrimResult = {
  entries: ConversationEntry[];
  /** Image parts replaced by a text marker. */
  imagesReplaced: number;
  /** History entries dropped (the trimmed note excluded). */
  dropped: number;
  tokensBefore: number;
  tokensAfter: number;
};

function isTrimmedNote(entry: ConversationEntry | undefined): boolean {
  return (
    entry?.kind === 'message' &&
    entry.role === 'developer' &&
    entry.content.length === 1 &&
    entry.content[0].type === 'text' &&
    entry.content[0].text === TRIMMED_NOTE
  );
}

/**
 * A cut before `entries[index]` is safe when it separates no tool_call from its tool_results: the entry
 * right before the cut is not a tool_call (its results, or the assistant text merged with it, would
 * follow) and the entry at the cut is not a tool_result (its call would be gone).
 */
function isSafeCut(entries: ConversationEntry[], index: number): boolean {
  const before = entries[index - 1];
  const at = entries[index];
  // The first check also keeps an assistant message that directly follows a tool_call run with its
  // calls: the provider merges the two into one assistant message.
  if (before?.kind === 'tool_call') return false;
  if (at?.kind === 'tool_result') return false;
  return true;
}

/**
 * Returns `entries` bounded by `budget` estimated tokens. `entries[0]` (the static prompt) is never
 * touched. When over budget: images in the older half of the history become an `[image]` marker; if
 * still over, the oldest history is dropped at tool-call-safe boundaries down to 75% of the budget and a
 * single trimmed note is placed right after the static prompt. The newest entry always survives. Never
 * mutates the input array or its entries.
 */
export function trimHistory(entries: ConversationEntry[], budget: number): TrimResult {
  const tokensBefore = estimateTokens(entries);
  const unchanged: TrimResult = { entries, imagesReplaced: 0, dropped: 0, tokensBefore, tokensAfter: tokensBefore };
  if (entries.length <= 1 || tokensBefore <= budget) return unchanged;

  const [staticPrompt, ...rest] = entries;
  const hadNote = isTrimmedNote(rest[0]);
  let history = hadNote ? rest.slice(1) : rest;

  // Phase 1: images in the older half of the history → text markers.
  let imagesReplaced = 0;
  const half = Math.floor(history.length / 2);
  history = history.map((entry, index) => {
    if (index >= half || entry.kind !== 'message' || !entry.content.some((p) => p.type === 'image')) return entry;
    return {
      ...entry,
      content: entry.content.map((part) => {
        if (part.type !== 'image') return part;
        imagesReplaced++;
        return { type: 'text' as const, text: IMAGE_PLACEHOLDER };
      }),
    };
  });

  const noteEntry: ConversationEntry = { kind: 'message', role: 'developer', content: [{ type: 'text', text: TRIMMED_NOTE }] };
  const assemble = (kept: ConversationEntry[], withNote: boolean) =>
    withNote ? [staticPrompt, noteEntry, ...kept] : [staticPrompt, ...kept];

  const afterImages = assemble(history, hadNote);
  const afterImagesTokens = estimateTokens(afterImages);
  if (afterImagesTokens <= budget) {
    return { entries: afterImages, imagesReplaced, dropped: 0, tokensBefore, tokensAfter: afterImagesTokens };
  }

  // Phase 2: drop the oldest history at safe boundaries until under the target (the note counts too).
  const target = Math.floor(budget * TRIM_TARGET_RATIO);
  const fixedTokens = estimateEntryTokens(staticPrompt) + estimateEntryTokens(noteEntry);
  let remaining = estimateTokens(history);
  let cut = 0;
  while (cut < history.length - 1 && fixedTokens + remaining > target) {
    let next = cut + 1;
    while (next < history.length - 1 && !isSafeCut(history, next)) next++;
    if (!isSafeCut(history, next)) break;
    for (let i = cut; i < next; i++) remaining -= estimateEntryTokens(history[i]);
    cut = next;
  }

  if (cut === 0) {
    return { entries: afterImages, imagesReplaced, dropped: 0, tokensBefore, tokensAfter: afterImagesTokens };
  }
  const trimmed = assemble(history.slice(cut), true);
  return { entries: trimmed, imagesReplaced, dropped: cut, tokensBefore, tokensAfter: estimateTokens(trimmed) };
}
