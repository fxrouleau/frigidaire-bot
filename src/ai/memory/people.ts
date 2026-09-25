// "Who is this about?" — turning a free-text subject the chat model wrote ("Wheezer", "me", "@Jason",
// "Derrick", "<@123>", "Felix (id:123)") into the member it refers to. Memories are keyed by the
// member's stable Discord id and filed under their CURRENT display name; display names change, ids
// don't, so a memory saved as "OldNick" still belongs to the same person after a rename.
import type { Message } from 'discord.js';
import { attributeMessage } from '../../relay';
import { type Identity, type MemoryStore, NON_PERSON_SUBJECTS, nameKey } from './memoryStore';

export type ResolvedPerson = {
  userId: string;
  /** The member's current display name: the subject new memories are filed under. */
  displayName: string;
  /** Every name their memories may already be filed under (current, first-seen, IRL, aliases). */
  names: string[];
};

// Words the model uses for the person talking to it ("remember that I …" → subject "me").
const SELF_REFERENCES: ReadonlySet<string> = new Set(['me', 'i', 'myself', 'my', 'mine']);

// `<@123>` / `<@!123>` mention tokens, the `(id:123)` suffix the prompts print after author names, or a
// bare snowflake.
const MENTION_TOKEN = /^<@!?(\d+)>$/;
const ID_SUFFIX = /\(\s*id:\s*(\d+)\s*\)/i;
const BARE_SNOWFLAKE = /^\d{15,21}$/;

/** A subject as written, minus decoration the model copies from prompts: a leading '@', an '(id:…)' suffix, quotes. */
export function cleanSubject(raw: string): string {
  return raw
    .replace(ID_SUFFIX, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^@+/, '')
    .trim();
}

/** Every name a member's memories may be filed under, current display name first, deduplicated. */
export function namesOf(identity: Identity | undefined, extra: (string | undefined)[] = []): string[] {
  const names = [
    ...extra,
    identity?.display_name,
    identity?.canonical_name,
    identity?.irl_name ?? undefined,
    ...(identity?.aliases ?? []),
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const trimmed = name?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * The one identity a name refers to, case-insensitively, in tiers: current display names first, then
 * first-seen names, IRL names, aliases. A tier matching two different members is ambiguous and stops
 * the search — guessing between two people would file a memory under the wrong one.
 */
export function matchIdentityByName(identities: Identity[], name: string): Identity | undefined {
  const needle = nameKey(name);
  if (!needle) return undefined;
  const tiers: ((identity: Identity) => (string | null)[])[] = [
    (i) => [i.display_name],
    (i) => [i.canonical_name],
    (i) => [i.irl_name],
    (i) => i.aliases,
  ];
  for (const namesInTier of tiers) {
    const hits = identities.filter((i) => namesInTier(i).some((n) => nameKey(n) === needle));
    const distinct = new Set(hits.map((i) => i.discord_user_id));
    if (distinct.size === 1) return hits[0];
    if (distinct.size > 1) return undefined;
  }
  return undefined;
}

/** Live display name of a user @-mentioned in the message (guild nickname first). */
function mentionedDisplayName(message: Message, userId: string): string | undefined {
  const member = message.mentions?.members?.get(userId);
  if (member?.displayName) return member.displayName;
  const user = message.mentions?.users?.get(userId);
  return user?.displayName || user?.username || undefined;
}

/**
 * Resolves a subject to a member, or undefined for the server, the bot, and anyone it can't pin down.
 * Order: self-references ("me") → an explicit id → a user @-mentioned in the triggering message →
 * the identities table (display, first-seen, IRL names, aliases). `message` is the message the chat
 * turn is answering; without it only ids and the identities table are consulted.
 */
export function resolvePerson(store: MemoryStore, rawSubject: string, message?: Message): ResolvedPerson | undefined {
  const idMatch = rawSubject.trim().match(MENTION_TOKEN) ?? rawSubject.match(ID_SUFFIX);
  const subject = cleanSubject(rawSubject);
  const key = nameKey(subject);
  if (!idMatch && (!key || NON_PERSON_SUBJECTS.has(key))) return undefined;

  const person = (userId: string, liveName: string | undefined): ResolvedPerson | undefined => {
    const identity = store.getIdentityById(userId);
    const displayName = liveName || identity?.display_name;
    if (!displayName) return undefined;
    return { userId, displayName, names: namesOf(identity, [displayName]) };
  };

  if (SELF_REFERENCES.has(key)) {
    const speaker = message ? attributeMessage(message) : undefined;
    return speaker?.authorId ? person(speaker.authorId, speaker.authorName) : undefined;
  }

  // An id nobody knows falls through to the name ("Felix (id:999)" can still resolve as Felix).
  const explicitId = idMatch?.[1] ?? (BARE_SNOWFLAKE.test(subject) ? subject : undefined);
  if (explicitId && explicitId !== message?.client?.user?.id) {
    const byId = person(explicitId, message ? mentionedDisplayName(message, explicitId) : undefined);
    if (byId) return byId;
  }

  if (message) {
    const botId = message.client?.user?.id;
    const mentioned = [...(message.mentions?.users?.values() ?? [])].filter((user) => {
      if (user.id === botId || user.bot) return false;
      const candidates = [mentionedDisplayName(message, user.id), user.displayName, user.username, user.globalName];
      return candidates.some((n) => nameKey(n) === key);
    });
    if (mentioned.length === 1) return person(mentioned[0].id, mentionedDisplayName(message, mentioned[0].id));
  }

  const identity = matchIdentityByName(
    store.getAllIdentities().filter((i) => i.active !== 0),
    subject,
  );
  return identity ? person(identity.discord_user_id, undefined) : undefined;
}
