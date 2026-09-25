// Pure text helpers shared by the addressed-to-bot gate, the ramble check and the gate eval runner:
// the cheap prefilter rules (name match, follow-up window) and the readable text a decision model sees.
// Kept free of Discord objects so the eval runs exactly the same rules over synthetic cases.

const URL_REGEX = /\bhttps?:\/\/\S+/gi;
// Discord markup: custom emojis <:name:id> / <a:name:id>, user/role/channel mentions, timestamps.
const CUSTOM_EMOJI_REGEX = /<a?:(\w{2,32}):\d{17,20}>/g;
const USER_MENTION_REGEX = /<@!?(\d{17,20})>/g;
const ROLE_MENTION_REGEX = /<@&\d{17,20}>/g;
const CHANNEL_MENTION_REGEX = /<#\d{17,20}>/g;
const TIMESTAMP_REGEX = /<t:-?\d+(?::[a-zA-Z])?>/g;

/**
 * Removes everything that is not prose for name matching: URLs (a link to someone's "botname" profile
 * is not an address), emoji markup (an emoji named `clanker` is not the word), mentions, timestamps.
 */
export function stripMarkup(text: string): string {
  return text
    .replace(URL_REGEX, ' ')
    .replace(CUSTOM_EMOJI_REGEX, ' ')
    .replace(USER_MENTION_REGEX, ' ')
    .replace(ROLE_MENTION_REGEX, ' ')
    .replace(CHANNEL_MENTION_REGEX, ' ')
    .replace(TIMESTAMP_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a whole-word, case-insensitive matcher over `names`. Word boundaries are Unicode-aware (a
 * letter, digit or underscore on either side blocks the match), so "fridge," and "fridge's" match but
 * "refridgerator", "fridges" and "frigid" don't. Returns the first name found, or undefined.
 */
export function createNameMatcher(names: readonly string[]): (text: string) => string | undefined {
  const cleaned = [...new Set(names.map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0))];
  if (cleaned.length === 0) return () => undefined;
  // Longest first so "frigidaire" wins over a hypothetical "frigi" prefix in the alternation.
  cleaned.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${cleaned.map(escapeRegex).join('|')})(?![\\p{L}\\p{N}_])`, 'iu');
  return (text) => {
    const match = stripMarkup(text).match(pattern);
    return match ? match[0].toLowerCase() : undefined;
  };
}

/**
 * The follow-up rule: the bot spoke in this channel at most `followupSeconds` before the message, and
 * the message's author is who it was talking to. `followupSeconds` of 0 disables the rule.
 */
export function isFollowup(
  secondsSinceBotSpoke: number | undefined,
  authorIsBotsPartner: boolean,
  followupSeconds: number,
): boolean {
  if (followupSeconds <= 0 || !authorIsBotsPartner || secondsSinceBotSpoke === undefined) return false;
  return secondsSinceBotSpoke >= 0 && secondsSinceBotSpoke <= followupSeconds;
}

/**
 * Discord markup rendered the way a person reads it: custom emojis become `:name:`, user mentions
 * `@Name` (via `resolveUser`; unresolved ids become `@someone`), channels `#channel`, roles `@role`.
 */
export function readableMarkup(text: string, resolveUser: (id: string) => string | undefined): string {
  return text
    .replace(CUSTOM_EMOJI_REGEX, (_m, name: string) => `:${name}:`)
    .replace(USER_MENTION_REGEX, (_m, id: string) => `@${resolveUser(id) ?? 'someone'}`)
    .replace(ROLE_MENTION_REGEX, '@role')
    .replace(CHANNEL_MENTION_REGEX, '#channel')
    .replace(TIMESTAMP_REGEX, '(a time)')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * How long ago the bot spoke, in words. Decision models read semantic phrases more reliably than raw
 * numbers (TypeSafe's jev-1.13 guidance: keep arithmetic in code), so the gate never sends seconds.
 */
export function describeBotLastSpoke(seconds: number | undefined): string {
  if (seconds === undefined || seconds < 0) return 'not recently (nothing from the bot in the last 10 minutes)';
  if (seconds < 20) return 'just now, right before the latest message';
  if (seconds < 60) return `${Math.round(seconds)} seconds before the latest message`;
  if (seconds < 120) return 'about a minute before the latest message';
  if (seconds <= 600) return `${Math.round(seconds / 60)} minutes before the latest message`;
  return 'not recently (nothing from the bot in the last 10 minutes)';
}
