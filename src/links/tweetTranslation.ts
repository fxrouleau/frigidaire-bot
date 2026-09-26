// Translation of foreign-language tweets. X translates in its own app, but a Discord embed shows the
// original text and the group reads English. Both Twitter fixer projects translate when a language
// code is appended to the post path (verified 2026-09 against a Japanese @nhk_news post):
//   - FxTwitter (fxtwitter.com, fixupx.com, twittpr.com): "📑 Translated from Japanese" + the
//     translation, with the original text quoted below it
//   - vxTwitter (vxtwitter.com, fixvx.com — fixvx 302s to vxtwitter keeping the suffix): "🌐 JA→EN"
//     + the translation
// Both leave a post that is already in the target language unchanged, but the bot only appends the
// code when the tweet's language is known to differ, so an English tweet keeps its plain URL.
import { logger } from '../logger';

/** Fixer domains verified to translate on a `/<lang>` suffix. Any other domain gets the plain URL. */
export const TRANSLATING_TWITTER_FIXERS: ReadonlySet<string> = new Set([
  'fxtwitter.com',
  'fixupx.com',
  'twittpr.com',
  'vxtwitter.com',
  'fixvx.com',
]);

const STATUS_API = 'https://api.fxtwitter.com/status/';
// The language lookup runs alongside the fixer probe and never holds the repost up for long.
const MAX_LOOKUP_MS = 2500;
const LOOKUP_USER_AGENT = 'FrigidaireBot/1.0 (Discord link fixer; language lookup)';

// Codes X uses for "not a language": undetermined, no linguistic content, and the ISO 639 private-use
// range qaa–qtz (qme = media only, qht = hashtags only, qam = mentions only, qct = cashtags, qst = short).
const NON_LANGUAGES = new Set(['und', 'zxx', 'mul', 'mis', 'art']);

function baseLanguage(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0];
}

/** True when a tweet in `lang` should be shown translated into `target`. */
export function shouldTranslate(lang: string | undefined, target: string): boolean {
  if (!lang) return false;
  const base = baseLanguage(lang);
  if (base.length === 0 || NON_LANGUAGES.has(base) || /^q[a-t][a-z]$/.test(base)) return false;
  return base !== baseLanguage(target);
}

export function supportsTranslation(domain: string): boolean {
  return TRANSLATING_TWITTER_FIXERS.has(domain.toLowerCase());
}

/**
 * The tweet's language according to FxTwitter's public status API (`tweet.lang`), or undefined when
 * the lookup fails, times out or the tweet doesn't exist. Never throws: translation is a bonus, and
 * a failed lookup just means the link is fixed untranslated.
 */
export async function lookupTweetLanguage(
  statusId: string,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const response = await fetchFn(`${STATUS_API}${statusId}`, {
      headers: { accept: 'application/json', 'user-agent': LOOKUP_USER_AGENT },
      signal: AbortSignal.timeout(Math.min(timeoutMs, MAX_LOOKUP_MS)),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      logger.info(`linkfix: tweet ${statusId} language lookup answered HTTP ${response.status}`);
      return undefined;
    }
    const body = (await response.json()) as { tweet?: { lang?: unknown } } | null;
    const lang = body?.tweet?.lang;
    return typeof lang === 'string' && lang.length > 0 ? lang : undefined;
  } catch (error) {
    logger.info(`linkfix: tweet ${statusId} language lookup failed; leaving it untranslated:`, error);
    return undefined;
  }
}
