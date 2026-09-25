// "Who is this about?" — turning names into the members they refer to. Two entry points:
//  - resolvePerson(): a free-text subject the chat model wrote ("Wheezer", "me", "@Jason", "Derrick",
//    "cigalefourmi", "<@123>", "Felix (id:123)") → the one member it means.
//  - findPeopleInText(): every member a piece of chat text refers to (mention tokens and any name they
//    go by), for summaries and anything else that needs "who is this conversation about".
// Memories are keyed by the member's stable Discord id and filed under their CURRENT display name;
// display names change, ids don't, so a memory saved as "OldNick" still belongs to the same person
// after a rename. A member goes by up to six kinds of name: display name, Discord handle (username),
// first-seen display name, IRL name and nicknames (aliases), plus their id.
import type { Message } from 'discord.js';
import {
  findIdentitiesByName,
  type Identity,
  type MemoryStore,
  matchIdentityByName,
  NON_PERSON_SUBJECTS,
  nameKey,
} from './memory/memoryStore';
import { STOP_WORDS } from './memory/wordOverlap';
import { attributeMessage } from '../relay';

export { findIdentitiesByName, matchIdentityByName };

export type ResolvedPerson = {
  userId: string;
  /** The member's current display name: the subject new memories are filed under. */
  displayName: string;
  /** Every name their memories may already be filed under (current, handle, first-seen, IRL, aliases). */
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
    identity?.username ?? undefined,
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
 * the identities table (display name, handle, first-seen name, IRL name, nicknames). `message` is the
 * message the chat turn is answering; without it only ids and the identities table are consulted.
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

// ---------------------------------------------------------------------------------------------------
// Finding people in chat text
// ---------------------------------------------------------------------------------------------------

/** A member referenced in text, with how many times. */
export type PersonReference = ResolvedPerson & { identity: Identity; count: number };

// Names shorter than this are never matched in free text: a one-letter nickname ("D") would match ":D",
// "D-day" and every grade. Two letters stay in: real names like "Yi" or "JJ" are that short.
const MIN_TEXT_NAME_LENGTH = 2;
const MENTION_TOKENS = /<@!?(\d+)>/g;
// Stripped before name matching: a handle inside a link ("twitter.com/jason/status/…") or an emoji
// name (<:jason:123>) is not a reference to the member.
const NOT_PROSE = /https?:\/\/\S+|<a?:\w+:\d+>|<[#@]&?!?\d+>/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a reusable matcher over the given identities (build it once to scan many messages). A name
 * counts only when it names exactly one member (findIdentitiesByName); matching is case-insensitive and
 * on whole words, so "Dan" does not match "dance".
 */
export function createPeopleMatcher(identities: Identity[]): (text: string) => Map<string, number> {
  const active = identities.filter((i) => i.active !== 0);
  const byId = new Map(active.map((i) => [i.discord_user_id, i]));
  const idByName = new Map<string, string>();
  for (const identity of active) {
    for (const name of namesOf(identity)) {
      const key = nameKey(name);
      if ([...key].length < MIN_TEXT_NAME_LENGTH || idByName.has(key)) continue;
      if (STOP_WORDS.has(key) || NON_PERSON_SUBJECTS.has(key)) continue;
      const hits = findIdentitiesByName(active, name);
      if (hits.length === 1) idByName.set(key, hits[0].discord_user_id);
    }
  }

  // Longest names first so "Big Mike" wins over "Mike" at the same position.
  const alternatives = [...idByName.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const namePattern =
    alternatives.length > 0 ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_])`, 'giu') : undefined;

  return (text: string) => {
    const counts = new Map<string, number>();
    const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const match of text.matchAll(MENTION_TOKENS)) {
      if (byId.has(match[1])) bump(match[1]);
    }
    if (namePattern) {
      for (const match of text.replace(NOT_PROSE, ' ').matchAll(namePattern)) {
        const id = idByName.get(nameKey(match[0]));
        if (id) bump(id);
      }
    }
    return counts;
  };
}

/** Turns per-member counts into references, most referenced first (ties: the order they were first seen). */
export function toPersonReferences(counts: Map<string, number>, identities: Identity[]): PersonReference[] {
  const byId = new Map(identities.map((i) => [i.discord_user_id, i]));
  const refs: PersonReference[] = [];
  for (const [userId, count] of counts) {
    const identity = byId.get(userId);
    if (!identity) continue;
    refs.push({ userId, displayName: identity.display_name, names: namesOf(identity), identity, count });
  }
  // Array.prototype.sort is stable, so equal counts keep their first-seen order.
  return refs.sort((a, b) => b.count - a.count);
}

/**
 * The members a piece of chat text refers to: `<@id>` mention tokens, and whole-word, case-insensitive
 * occurrences of any name they go by (display name, handle, first-seen name, IRL name, nicknames).
 * Names shared by two members and one-letter nicknames are skipped rather than guessed. Most
 * referenced first. For many texts, build one createPeopleMatcher() instead of calling this per text.
 */
export function findPeopleInText(store: MemoryStore, text: string): PersonReference[] {
  const identities = store.getAllIdentities().filter((i) => i.active !== 0);
  return toPersonReferences(createPeopleMatcher(identities)(text), identities);
}
