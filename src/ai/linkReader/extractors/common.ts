// Shared plumbing for the per-platform extractors.
import { type FetchOptions, type FetchResult, type SafeFetch, decodeText, parseJsonBody } from '../safeFetch';
import { sniffCharset } from '../html';

export type ExtractorContext = {
  fetch: SafeFetch;
  now: () => number;
  /** True while a flaky upstream (a dead fixer domain, Reddit's JSON API) is being skipped. */
  isCoolingDown: (key: string) => boolean;
  coolDown: (key: string, ms: number) => void;
};

/** A failure worth telling the model about ("that post was deleted"); its message is shown verbatim. */
export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

// The main text the model gets. Big enough for a long article's substance, small enough that a few
// reads in one turn don't crowd out the conversation.
export const MAX_TEXT_CHARS = 7000;

// Honest identification for JSON APIs (FxTwitter, Bluesky, Reddit); pages get Discord's crawler UA
// instead, because that is what sites special-case to serve their preview metadata.
export const API_USER_AGENT = 'FrigidaireBot/1.0 (Discord link reader)';

export function capText(text: string | undefined, max = MAX_TEXT_CHARS): { text?: string; truncated: boolean } {
  const trimmed = text?.trim();
  if (!trimmed) return { truncated: false };
  if (trimmed.length <= max) return { text: trimmed, truncated: false };
  const cut = trimmed.slice(0, max);
  // Prefer ending on a sentence or line break near the cap over cutting mid-word.
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return { text: `${(boundary > max * 0.8 ? cut.slice(0, boundary + 1) : cut).trimEnd()}…`, truncated: true };
}

// ---- Untrusted JSON accessors ----

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Epoch ms from an ISO-ish date string, or undefined. */
export function parseDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

// ---- Fetch wrappers ----

export async function fetchJson(
  ctx: ExtractorContext,
  url: string,
  options: Partial<FetchOptions> = {},
): Promise<{ result: FetchResult; json: unknown }> {
  const result = await ctx.fetch(url, {
    userAgent: API_USER_AGENT,
    ...options,
    accept: options.accept ?? ['application/json', '*+json', 'text/json'],
  });
  return { result, json: parseJsonBody(result) };
}

export async function fetchHtml(
  ctx: ExtractorContext,
  url: string,
  options: Partial<FetchOptions> = {},
): Promise<{ result: FetchResult; html?: string }> {
  const result = await ctx.fetch(url, { ...options, accept: options.accept ?? ['text/html', 'application/xhtml+xml'] });
  if (!result.body) return { result };
  return { result, html: decodeText(result.body, result.charset ?? sniffCharset(result.body)) };
}

/** Follows ONE redirect hop without reading anything (share links, short links). */
export async function resolveRedirect(
  ctx: ExtractorContext,
  url: string,
  userAgent?: string,
): Promise<string | undefined> {
  // An empty accept list means no body is ever downloaded; the header still asks for a page.
  const result = await ctx.fetch(url, { accept: [], headers: { accept: 'text/html,*/*' }, redirect: 'manual', userAgent });
  return result.location;
}
