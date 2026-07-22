// Shared env-var parsing helpers. CLAUDE.md documents several env vars as <bool>, but historically
// each site parsed them differently (DEBUG_CAPTURE only disabled on '0', DIGEST_ENABLED only on
// 'false', etc.), so `DEBUG_CAPTURE=false` or `DIGEST_ENABLED=0` silently did nothing. envBool() is
// the single boolean-parsing convention: use it for every boolean env flag.
import process from 'node:process';

/**
 * Parses a boolean env var (read at call time, so tests and runtime toggles both work).
 *
 * Case-insensitive, tolerant of stray whitespace and surrounding quotes:
 * - 'true' / '1' / 'yes'  -> true
 * - 'false' / '0' / 'no'  -> false
 * - unset / empty / anything else -> defaultValue
 */
export function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;

  // Strip whitespace and one layer of surrounding quotes ("true", 'true') — stray quoting from
  // compose files or shell exports shouldn't silently flip a flag to its default.
  const normalized = raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim()
    .toLowerCase();

  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return defaultValue;
}
