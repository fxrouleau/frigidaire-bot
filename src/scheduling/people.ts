// Resolving "who" for the scheduling tools. The model passes whatever the conversation used — a display
// name, a nickname, an IRL first name, an alias, an @mention, "me" — and reminders and birthdays need a
// stable Discord user id. Sources: the requester, the identities table (display/canonical/IRL names and
// the aliases the learner collected), the users mentioned in the triggering message, and the cached
// guild members (people the identity tracker hasn't seen talk yet).
import type { Message } from 'discord.js';
import { getMemoryStore } from '../ai/memory';
import { logger } from '../logger';
import { attributeMessage } from '../relay';

export type Person = { userId: string; name: string };

type Candidate = Person & { names: string[] };

export type PersonDirectory = {
  requester: Person;
  candidates: Candidate[];
};

export type PeopleResolution = { ok: true; people: Person[] } | { ok: false; error: string };
type PersonResolution = { ok: true; person: Person } | { ok: false; error: string };

const MENTION_OR_ID = /^(?:<@!?(\d{15,21})>|(\d{15,21}))$/;
const SELF_WORDS = new Set(['me', 'myself', 'i', 'requester', 'the requester']);
const CROWD_WORDS = new Set(['everyone', 'here', 'all', 'everybody', 'the group', 'the server', 'chat', 'yall']);
const MAX_KNOWN_LISTED = 40;

/** Who asked: the real author of the triggering message (a relayed message counts as its member). */
export function requesterOf(message: Message): Person {
  const attribution = attributeMessage(message);
  if (attribution?.authorId) return { userId: attribution.authorId, name: attribution.authorName };
  return {
    userId: message.author.id,
    name: message.member?.displayName || message.author.displayName || message.author.username,
  };
}

/** Everyone the triggering message's context can name. Never throws: a failing source is just skipped. */
export function buildDirectory(message: Message): PersonDirectory {
  const requester = requesterOf(message);
  const botId = message.client?.user?.id;
  const byId = new Map<string, Candidate>();
  const add = (userId: string, name: string | undefined | null, names: Array<string | null | undefined>) => {
    if (!userId || userId === botId) return;
    const clean = names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map((n) => n.trim());
    const existing = byId.get(userId);
    if (existing) {
      for (const n of clean) if (!existing.names.includes(n)) existing.names.push(n);
      return;
    }
    const display = name?.trim() || clean[0];
    if (!display) return;
    byId.set(userId, { userId, name: display, names: [...new Set([display, ...clean])] });
  };

  // Identities first: their display name is the one memories are stored under, so it wins as the label.
  try {
    for (const identity of getMemoryStore().getAllIdentities()) {
      if (identity.active === 0) continue;
      add(identity.discord_user_id, identity.display_name, [
        identity.display_name,
        identity.canonical_name,
        identity.irl_name,
        ...identity.aliases,
      ]);
    }
  } catch (error) {
    logger.warn('scheduling: failed to read identities for name resolution:', error);
  }

  add(requester.userId, requester.name, [requester.name, message.author.username]);

  try {
    for (const user of message.mentions.users.values()) {
      const member = message.mentions.members?.get(user.id);
      add(user.id, member?.displayName ?? user.displayName, [
        member?.displayName,
        user.displayName,
        user.username,
        user.globalName,
      ]);
    }
  } catch (error) {
    logger.warn('scheduling: failed to read message mentions for name resolution:', error);
  }

  try {
    const members = message.guild?.members.cache;
    if (members) {
      for (const member of members.values()) {
        if (member.user.bot) continue;
        add(member.id, member.displayName, [
          member.displayName,
          member.nickname,
          member.user.username,
          member.user.globalName,
        ]);
      }
    }
  } catch (error) {
    logger.warn('scheduling: failed to read guild members for name resolution:', error);
  }

  return { requester, candidates: [...byId.values()] };
}

function normalize(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Candidates are unique by user id (buildDirectory merges sources), so matches are too.
function pick(distinct: Candidate[], shown: string): PersonResolution | undefined {
  if (distinct.length === 1) return { ok: true, person: { userId: distinct[0].userId, name: distinct[0].name } };
  if (distinct.length > 1) {
    const options = distinct.map((c) => `${c.name} (id:${c.userId})`).join(' or ');
    return { ok: false, error: `"${shown}" could be ${options} — say which one (passing the id works).` };
  }
  return undefined;
}

/** Resolves one reference to a person, or explains (for the model) why it couldn't. */
export function resolvePerson(ref: string, directory: PersonDirectory): PersonResolution {
  const raw = ref.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!raw) return { ok: false, error: 'Empty name — say who.' };

  const idMatch = raw.match(MENTION_OR_ID);
  if (idMatch) {
    const id = idMatch[1] ?? idMatch[2];
    if (id === directory.requester.userId) return { ok: true, person: directory.requester };
    const known = directory.candidates.find((c) => c.userId === id);
    if (known) return { ok: true, person: { userId: known.userId, name: known.name } };
    return { ok: false, error: `I don't know anyone with id ${id} in this server.` };
  }

  const shown = raw.replace(/^@/, '');
  const needle = normalize(shown);
  if (SELF_WORDS.has(needle)) return { ok: true, person: directory.requester };
  if (CROWD_WORDS.has(needle)) {
    return { ok: false, error: 'Only specific people can be named (no @everyone/@here or roles) — list them by name.' };
  }

  const exact = directory.candidates.filter((c) => c.names.some((n) => normalize(n) === needle));
  const exactPick = pick(exact, shown);
  if (exactPick) return exactPick;

  // A first or last name inside a longer name: "felix" → "Felix Rouleau", "gamer" → "big gamer".
  const word = directory.candidates.filter((c) =>
    c.names.some((n) =>
      normalize(n)
        .split(/[\s._-]+/)
        .includes(needle),
    ),
  );
  const wordPick = pick(word, shown);
  if (wordPick) return wordPick;

  if (needle.length >= 3) {
    const prefix = directory.candidates.filter((c) => c.names.some((n) => normalize(n).startsWith(needle)));
    const prefixPick = pick(prefix, shown);
    if (prefixPick) return prefixPick;
  }

  const known = directory.candidates
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_KNOWN_LISTED);
  const knownPart = known.length > 0 ? ` People I know: ${known.join(', ')}.` : '';
  return { ok: false, error: `I don't know who "${shown}" is.${knownPart}` };
}

/** Resolves every reference (deduplicated by user id); the first failure aborts with its explanation. */
export function resolvePeople(refs: string[], directory: PersonDirectory): PeopleResolution {
  const people: Person[] = [];
  for (const ref of refs) {
    const resolved = resolvePerson(ref, directory);
    if (!resolved.ok) return resolved;
    if (!people.some((p) => p.userId === resolved.person.userId)) people.push(resolved.person);
  }
  return { ok: true, people };
}

/** The current display name for a user id (identities, then the fallback). */
export function currentName(userId: string, fallback: string): string {
  try {
    return getMemoryStore().getIdentityById(userId)?.display_name ?? fallback;
  } catch {
    return fallback;
  }
}
