// Members referenced by name in plain text ("did jason ever pay you back?"), not only by @-mention.
// People in the server almost never @ someone they're talking *about*, so without this the chat agent
// only pulled memories for the speaker and for explicit pings.
//
// Deliberately conservative: whole-word, case-insensitive matches of names at least MIN_NAME_LENGTH
// long, never a stop word, never one of the bot's own names, and never inside a mention, custom-emoji
// token or URL (a `<:jason:123>` emoji is not a reference to Jason).
import type { Identity } from './memory/memoryStore';
import { STOP_WORDS } from './memory/wordOverlap';

export const MIN_NAME_LENGTH = 3;

// Mentions (`<@123>`, `<@&123>`, `<#123>`), custom emojis (`<:name:id>`, `<a:name:id>`), timestamps
// and URLs: tokens whose text is not something a person typed as a name.
const NON_PROSE_TOKENS = /<[@#][!&]?\d+>|<a?:\w+:\d+>|<t:\d+(?::\w)?>|https?:\/\/\S+/g;

/**
 * Every full name a member may be filed or called under: current display name, first-seen (canonical)
 * name, IRL name, aliases, and `username` when the identities row carries one. Trimmed, deduplicated
 * case-insensitively. Also the key set for memory lookups by person.
 */
export function identityNames(identity: Identity): string[] {
  // `username` is being added to the identities table by another change; read it only when present.
  const username = (identity as Identity & { username?: unknown }).username;
  const raw = [
    identity.display_name,
    identity.canonical_name,
    identity.irl_name,
    ...identity.aliases,
    typeof username === 'string' ? username : undefined,
  ];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const candidate of raw) {
    const name = candidate?.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

/** The first word of a multi-word IRL name ("Jason" of "Jason Smith"), which is what friends type. */
function irlFirstName(identity: Identity): string | undefined {
  const words = identity.irl_name?.trim().split(/\s+/) ?? [];
  return words.length > 1 ? words[0] : undefined;
}

/**
 * Per identity, the names text is matched against: its full names, plus its IRL first name when that is
 * unambiguous — not another member's IRL first name too, and not one of another member's full names
 * (then "mike" most likely means the member actually called Mike).
 */
function matchableNames(identities: Identity[]): Map<Identity, string[]> {
  const fullNameOwners = new Map<string, Set<string>>();
  const firstNameCounts = new Map<string, number>();
  for (const identity of identities) {
    for (const name of identityNames(identity)) {
      const key = name.toLowerCase();
      const owners = fullNameOwners.get(key) ?? new Set<string>();
      owners.add(identity.discord_user_id);
      fullNameOwners.set(key, owners);
    }
    const first = irlFirstName(identity)?.toLowerCase();
    if (first) firstNameCounts.set(first, (firstNameCounts.get(first) ?? 0) + 1);
  }

  const result = new Map<Identity, string[]>();
  for (const identity of identities) {
    const names = identityNames(identity);
    const first = irlFirstName(identity);
    if (first) {
      const key = first.toLowerCase();
      const owners = fullNameOwners.get(key);
      const claimedByOther = owners !== undefined && [...owners].some((id) => id !== identity.discord_user_id);
      if (firstNameCounts.get(key) === 1 && !claimedByOther && !names.some((n) => n.toLowerCase() === key)) {
        names.push(first);
      }
    }
    result.set(identity, names);
  }
  return result;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive whole-word pattern for a name; inner whitespace matches any run of whitespace. */
function namePattern(name: string): RegExp {
  const body = name
    .split(/\s+/)
    .map((word) => escapeRegExp(word))
    .join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'iu');
}

export type NamedPerson = { identity: Identity; name: string; index: number };

export type FindNamedPeopleOptions = {
  /** Discord ids never returned (the bot, the speaker, people already @-mentioned). */
  excludeUserIds?: Iterable<string>;
  /** Names never matched, compared case-insensitively (the bot's own names). */
  excludeNames?: Iterable<string>;
  /** At most this many people (default 3). */
  max?: number;
};

/**
 * The members `text` refers to by name, in order of first appearance (a longer name wins a tie, so
 * "Big Mike" beats "Mike" at the same spot). Inactive identities are skipped.
 */
export function findNamedPeople(
  text: string,
  identities: Identity[],
  opts: FindNamedPeopleOptions = {},
): NamedPerson[] {
  const prose = text.replace(NON_PROSE_TOKENS, ' ');
  if (prose.trim().length < MIN_NAME_LENGTH) return [];

  const excludedIds = new Set(opts.excludeUserIds ?? []);
  const excludedNames = new Set([...(opts.excludeNames ?? [])].map((n) => n.trim().toLowerCase()));
  const max = opts.max ?? 3;

  const active = identities.filter((identity) => identity.active !== 0);
  const namesByIdentity = matchableNames(active);

  const matches: NamedPerson[] = [];
  for (const identity of active) {
    if (excludedIds.has(identity.discord_user_id)) continue;
    let best: NamedPerson | undefined;
    for (const name of namesByIdentity.get(identity) ?? []) {
      const lower = name.toLowerCase();
      if (name.length < MIN_NAME_LENGTH || STOP_WORDS.has(lower) || excludedNames.has(lower)) continue;
      const found = namePattern(name).exec(prose);
      if (!found) continue;
      if (!best || found.index < best.index || (found.index === best.index && name.length > best.name.length)) {
        best = { identity, name, index: found.index };
      }
    }
    if (best) matches.push(best);
  }

  return matches.sort((a, b) => a.index - b.index || b.name.length - a.name.length).slice(0, Math.max(0, max));
}
