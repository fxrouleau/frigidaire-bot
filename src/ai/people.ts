// "Who is this?" — the one module that turns names, mentions and ids into members. Everything that
// needs a person goes through here: the chat agent (speaker, @-mentions, people named in plain text),
// the memory tools, summaries, the learner, reminders and birthdays, the context-menu commands.
//
// A member goes by several kinds of name: their current display name (server nickname), their Discord
// handle (username), the display name they were first seen under (canonical), their IRL name and the
// nicknames the group uses (aliases) — plus their user id. Some members also post from a side account
// (LINKED_ACCOUNTS): a side account's names are the member's names too, and every id resolves to the
// member's MAIN account id, which is what memories, reminders, birthdays and the archive key on.
//
// Entry points:
//  - lookupPerson(): one reference ("Wheezer", "me", "@Jason", "<@123>", "Felix (id:123)") → the one
//    member it means, or why it can't tell (unknown, ambiguous, a crowd, the bot). resolvePerson() and
//    resolvePersonRef() wrap it for the memory tools and for the scheduling tools.
//  - createPeopleMatcher() / findPeopleInText(): every member a piece of chat text refers to.
//  - memoryKeyFor(): the getForPerson() key (main id + every name of every account) for a member.
import type { Message } from 'discord.js';
import { accountIdsFor, canonicalUserId } from '../linkedAccounts';
import { logger } from '../logger';
import { attributeMessage } from '../relay';
import { getMemoryStore } from './memory';
import {
  IDENTITY_NAME_TIERS,
  type Identity,
  type MemoryStore,
  NON_PERSON_SUBJECTS,
  nameKey,
} from './memory/memoryStore';
import { STOP_WORDS } from './memory/wordOverlap';

/** A member as the bot knows them: the main account with any linked side accounts folded in. */
export type Member = {
  /** The main account's Discord id: what memories, reminders, birthdays and the archive key on. */
  userId: string;
  /** Current display name: what the group sees, and the subject new memories are filed under. */
  displayName: string;
  /** The main account's identities row; undefined when only a side account or live Discord data is known. */
  identity?: Identity;
  /** Identities rows of the member's linked side accounts that the bot has seen post. */
  sideAccounts: Identity[];
  /** Every name any of their accounts goes by, current display name first, deduplicated. */
  names: string[];
  /** Where the names come from (identities rows plus live Discord data), for tiered name matching. */
  rows: Identity[];
};

export type ResolvedPerson = {
  /** The member's main account id. */
  userId: string;
  /** The member's current display name: the subject new memories are filed under. */
  displayName: string;
  /** Every name their memories may already be filed under (all accounts: display, handle, first-seen, IRL, aliases). */
  names: string[];
};

/** Live Discord data about an account (message author, @-mentions, cached guild members). */
type LiveAccount = {
  userId: string;
  displayName: string;
  username?: string | null;
  globalName?: string | null;
  /** True when displayName is the server display name (guild member data), not just the global one. */
  serverName: boolean;
};

// Words for the person talking ("remember that I …" → "me"; "remind the requester").
const SELF_WORDS: ReadonlySet<string> = new Set(['me', 'i', 'myself', 'my', 'mine', 'requester', 'the requester']);
// Words for a group rather than a person. NON_PERSON_SUBJECTS adds 'server', 'bot', 'general', …
const CROWD_WORDS: ReadonlySet<string> = new Set([
  ...NON_PERSON_SUBJECTS,
  'all',
  'everybody',
  'the group',
  'the server',
  'chat',
  'yall',
  "y'all",
]);

// `<@123>` / `<@!123>` mention tokens, the `(id:123)` suffix the prompts print after names, or a bare snowflake.
const MENTION_TOKEN = /^<@!?(\d+)>$/;
const ID_SUFFIX = /\(\s*id:\s*(\d+)\s*\)/i;
const BARE_SNOWFLAKE = /^\d{15,21}$/;

/** A subject as written, minus decoration the model copies from prompts: an '(id:…)' suffix, quotes, a leading '@'. */
export function cleanSubject(raw: string): string {
  return raw
    .replace(ID_SUFFIX, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^@+/, '')
    .trim();
}

/** Every name a member's memories may be filed under, `extra` names first, deduplicated (exact spelling). */
export function namesOf(identity: Identity | undefined, extra: (string | null | undefined)[] = []): string[] {
  return namesOfAll(identity ? [identity] : [], extra);
}

/** namesOf() over several identities rows (a member's accounts), in order. */
function namesOfAll(rows: Identity[], extra: (string | null | undefined)[] = []): string[] {
  const names = [
    ...extra,
    ...rows.flatMap((row) => [row.display_name, row.username, row.canonical_name, row.irl_name, ...row.aliases]),
  ];
  // Exact-spelling dedup on purpose: getForPerson() compares subjects exactly, so "wheezer" and
  // "Wheezer" are both worth asking for.
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

/** The first word of a multi-word IRL name ("Jason" of "Jason Smith"): what friends actually type. */
function irlFirstName(identity: Identity): string | undefined {
  const words = identity.irl_name?.trim().split(/\s+/) ?? [];
  return words.length > 1 ? words[0] : undefined;
}

// The identities tiers (display name, handle, first-seen name, IRL name, nicknames) plus one weaker
// tier: the IRL first name. It only counts when no member has the name in a stronger form ("mike"
// means the member called Mike, not Mike Johnson) and exactly one member's IRL name starts with it.
const MEMBER_NAME_TIERS: readonly ((identity: Identity) => (string | null | undefined)[])[] = [
  ...IDENTITY_NAME_TIERS,
  (i) => [irlFirstName(i)],
];

function liveRow(account: LiveAccount): Identity {
  return {
    discord_user_id: account.userId,
    display_name: account.displayName,
    // The global display name ranks like a first-seen name: a real name for the account, but not the
    // one the server shows.
    canonical_name: account.globalName?.trim() || account.displayName,
    username: account.username ?? null,
    irl_name: null,
    aliases: [],
    first_seen_at: '',
    updated_at: '',
    active: 1,
  };
}

/**
 * Groups identities rows (and live Discord data) into members: one per main account, with linked side
 * accounts folded in. Inactive rows are skipped. Members come out in the order their first row appears.
 */
export function foldMembers(identities: Identity[], live: LiveAccount[] = []): Member[] {
  const groups = new Map<string, { table: Identity[]; live: LiveAccount[] }>();
  const groupOf = (userId: string) => {
    const main = canonicalUserId(userId);
    let group = groups.get(main);
    if (!group) {
      group = { table: [], live: [] };
      groups.set(main, group);
    }
    return group;
  };
  for (const identity of identities) {
    if (identity.active !== 0) groupOf(identity.discord_user_id).table.push(identity);
  }
  for (const account of live) {
    if (account.displayName.trim()) groupOf(account.userId).live.push(account);
  }

  const members: Member[] = [];
  for (const [userId, group] of groups) {
    const identity = group.table.find((i) => i.discord_user_id === userId);
    const sideAccounts = group.table.filter((i) => i.discord_user_id !== userId);
    const liveMain = group.live.filter((a) => a.userId === userId);
    const liveSide = group.live.filter((a) => a.userId !== userId);
    // The freshest name the server shows for the main account wins; a side account's name is only
    // the label when nothing is known about the main account.
    const displayName = [
      liveMain.find((a) => a.serverName)?.displayName,
      identity?.display_name,
      liveMain[0]?.displayName,
      sideAccounts[0]?.display_name,
      liveSide[0]?.displayName,
    ]
      .map((n) => n?.trim())
      .find((n): n is string => Boolean(n));
    if (!displayName) continue;
    const rows = [...(identity ? [identity] : []), ...sideAccounts, ...group.live.map(liveRow)];
    members.push({ userId, displayName, identity, sideAccounts, names: namesOfAll(rows, [displayName]), rows });
  }
  return members;
}

function toResolved(member: Member): ResolvedPerson {
  return { userId: member.userId, displayName: member.displayName, names: member.names };
}

/**
 * The members a name refers to, case- and accent-insensitively: the matches of the FIRST tier that has
 * any (display name, handle, first-seen name, IRL name, nickname, IRL first name — on any account).
 * One element = a unique match; more = ambiguous (e.g. two people called Alex IRL); none = nobody goes
 * by it. A display-name match wins over another member's nickname, so a nickname can never steal
 * someone's own name.
 */
export function findMembersByName(members: Member[], name: string): Member[] {
  const needle = nameKey(name);
  if (!needle) return [];
  for (const tier of MEMBER_NAME_TIERS) {
    const hits = members.filter((m) => m.rows.some((row) => tier(row).some((n) => nameKey(n) === needle)));
    if (hits.length > 0) return hits;
  }
  return [];
}

/** The one member a name refers to, or undefined when nobody or more than one member goes by it. */
export function matchMemberByName(members: Member[], name: string): Member | undefined {
  const hits = findMembersByName(members, name);
  return hits.length === 1 ? hits[0] : undefined;
}

// ---------------------------------------------------------------------------------------------------
// Resolving one reference
// ---------------------------------------------------------------------------------------------------

/** Everyone a lookup can name, from the identities table plus the triggering message's live data. */
export type PeopleDirectory = {
  members: Member[];
  /** Who sent the triggering message (its real author: a relay counts as its member), when there is one. */
  requester?: ResolvedPerson;
  /** Main ids of the members @-mentioned in the triggering message: a name they match wins. */
  mentioned: ReadonlySet<string>;
  botId?: string;
  /** Name keys of the bot itself: never a member. */
  botNames: ReadonlySet<string>;
};

function liveAccountsOf(message: Message, botId: string | undefined): { live: LiveAccount[]; mentioned: string[] } {
  const live: LiveAccount[] = [];
  const mentioned: string[] = [];
  if (!message.webhookId && !message.author.bot) {
    live.push({
      userId: message.author.id,
      displayName: message.member?.displayName || message.author.displayName || message.author.username,
      username: message.author.username,
      globalName: message.author.globalName,
      serverName: Boolean(message.member?.displayName),
    });
  }
  try {
    for (const user of message.mentions?.users?.values() ?? []) {
      if (user.id === botId || user.bot) continue;
      const memberName = message.mentions.members?.get(user.id)?.displayName;
      const name = memberName || user.displayName || user.username;
      mentioned.push(canonicalUserId(user.id));
      if (name) {
        live.push({
          userId: user.id,
          displayName: name,
          username: user.username,
          globalName: user.globalName,
          serverName: Boolean(memberName),
        });
      }
    }
  } catch (error) {
    logger.warn('people: failed to read message mentions:', error);
  }
  try {
    // Cached guild members: people the identity tracker hasn't seen talk yet can still be named.
    for (const member of message.guild?.members?.cache?.values() ?? []) {
      const user = member.user;
      if (!user || user.bot || member.id === botId || !member.displayName) continue;
      live.push({
        userId: member.id,
        displayName: member.displayName,
        username: user.username,
        globalName: user.globalName,
        serverName: true,
      });
    }
  } catch (error) {
    logger.warn('people: failed to read cached guild members:', error);
  }
  return { live, mentioned };
}

/**
 * The directory a lookup runs against: every active identity, plus (with a message) its author, the
 * users it @-mentions and the cached guild members. Never throws: a failing source is just skipped.
 */
export function buildPeopleDirectory(message?: Message, store?: MemoryStore): PeopleDirectory {
  let identities: Identity[] = [];
  try {
    identities = (store ?? getMemoryStore()).getAllIdentities();
  } catch (error) {
    logger.warn('people: failed to read identities:', error);
  }

  const botUser = message?.client?.user;
  const botId = botUser?.id;
  const { live, mentioned } = message ? liveAccountsOf(message, botId) : { live: [], mentioned: [] };
  const botIdentity = botId ? identities.find((i) => i.discord_user_id === botId) : undefined;
  const botNames = new Set(
    [
      botUser?.displayName,
      botUser?.username,
      message?.guild?.members?.me?.displayName,
      ...(botIdentity ? namesOf(botIdentity) : []),
    ]
      .map(nameKey)
      .filter((key) => key.length > 0),
  );
  const members = foldMembers(
    identities.filter((i) => !botId || canonicalUserId(i.discord_user_id) !== botId),
    live,
  );

  let requester: ResolvedPerson | undefined;
  if (message) {
    const asker = requesterOf(message);
    const member = members.find((m) => m.userId === asker.userId);
    requester = member ? toResolved(member) : asker;
  }
  return { members, requester, mentioned: new Set(mentioned), botId, botNames };
}

export type PersonLookup =
  | { ok: true; person: ResolvedPerson }
  | { ok: false; reason: 'empty' | 'no-requester' | 'crowd' | 'bot' | 'unknown' }
  | { ok: false; reason: 'unknown-id'; id: string }
  | { ok: false; reason: 'ambiguous'; candidates: ResolvedPerson[] };

function pick(hits: Member[]): PersonLookup | undefined {
  if (hits.length === 1) return { ok: true, person: toResolved(hits[0]) };
  if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits.map(toResolved) };
  return undefined;
}

/**
 * Resolves one reference to a member. Order: an explicit id (mention token, "(id:…)" suffix, bare
 * snowflake; a side account's id means its main account) → "me" (the requester) → a crowd or the bot
 * (never a person) → a member @-mentioned in the message whose name it is → every member by name tier
 * (see findMembersByName). With `fuzzy` (reminders, birthdays), a word inside a longer name ("gamer" →
 * "big gamer") and then a prefix of 3+ characters ("whee" → "Wheezer") also count. Two candidates at
 * the same step are reported as ambiguous, never guessed.
 */
export function lookupPerson(directory: PeopleDirectory, rawRef: string, opts: { fuzzy?: boolean } = {}): PersonLookup {
  const raw = rawRef.trim().replace(/^["'`]+|["'`]+$/g, '');
  const idMatch = raw.match(MENTION_TOKEN) ?? raw.match(ID_SUFFIX);
  const shown = cleanSubject(raw);
  const key = nameKey(shown);
  if (!idMatch && !key) return { ok: false, reason: 'empty' };

  const explicitId = idMatch?.[1] ?? (BARE_SNOWFLAKE.test(shown) ? shown : undefined);
  if (explicitId) {
    const userId = canonicalUserId(explicitId);
    if (directory.botId && (explicitId === directory.botId || userId === directory.botId)) {
      return { ok: false, reason: 'bot' };
    }
    const member = directory.members.find((m) => m.userId === userId);
    if (member) return { ok: true, person: toResolved(member) };
    // An id nobody knows: the name written next to it may still resolve ("Felix (id:999)").
    if (MENTION_TOKEN.test(raw) || BARE_SNOWFLAKE.test(shown) || !key) {
      return { ok: false, reason: 'unknown-id', id: explicitId };
    }
  }

  if (SELF_WORDS.has(key)) {
    return directory.requester ? { ok: true, person: directory.requester } : { ok: false, reason: 'no-requester' };
  }
  if (directory.botNames.has(key) || key === 'bot') return { ok: false, reason: 'bot' };
  if (CROWD_WORDS.has(key)) return { ok: false, reason: 'crowd' };

  const mentioned = directory.members.filter((m) => directory.mentioned.has(m.userId));
  const byMention = findMembersByName(mentioned, shown);
  if (byMention.length === 1) return { ok: true, person: toResolved(byMention[0]) };

  const exact = pick(findMembersByName(directory.members, shown));
  if (exact) return exact;

  if (opts.fuzzy) {
    const word = pick(
      directory.members.filter((m) =>
        m.names.some((n) =>
          nameKey(n)
            .split(/[\s._-]+/)
            .includes(key),
        ),
      ),
    );
    if (word) return word;
    if ([...key].length >= 3) {
      const prefix = pick(directory.members.filter((m) => m.names.some((n) => nameKey(n).startsWith(key))));
      if (prefix) return prefix;
    }
  }
  return { ok: false, reason: 'unknown' };
}

/**
 * The member a free-text subject the chat model wrote refers to, or undefined for the server, the bot,
 * and anyone it can't pin down (unknown or ambiguous: guessing would file a memory under the wrong
 * person). `message` is the message the chat turn answers; without it only ids and the identities
 * table are consulted.
 */
export function resolvePerson(store: MemoryStore, rawSubject: string, message?: Message): ResolvedPerson | undefined {
  const result = lookupPerson(buildPeopleDirectory(message, store), rawSubject);
  return result.ok ? result.person : undefined;
}

const MAX_KNOWN_LISTED = 40;

/** Why a lookup failed, in words the chat model can act on (ask who, pass an id, pick one). */
export function explainLookupFailure(
  result: Exclude<PersonLookup, { ok: true }>,
  rawRef: string,
  directory: PeopleDirectory,
): string {
  const shown = cleanSubject(rawRef.trim()) || rawRef.trim();
  switch (result.reason) {
    case 'empty':
      return 'Empty name — say who.';
    case 'no-requester':
      return "Can't tell who is asking — name them.";
    case 'crowd':
      return 'Only specific people can be named (no @everyone/@here or roles) — list them by name.';
    case 'bot':
      return "That's the bot itself — name a member.";
    case 'unknown-id':
      return `I don't know anyone with id ${result.id} in this server.`;
    case 'ambiguous': {
      const options = result.candidates.map((c) => `${c.displayName} (id:${c.userId})`).join(' or ');
      return `"${shown}" could be ${options} — say which one (passing the id works).`;
    }
    case 'unknown': {
      const known = directory.members
        .map((m) => m.displayName)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, MAX_KNOWN_LISTED);
      const knownPart = known.length > 0 ? ` People I know: ${known.join(', ')}.` : '';
      return `I don't know who "${shown}" is.${knownPart}`;
    }
  }
}

export type PersonRefResolution = { ok: true; person: ResolvedPerson } | { ok: false; error: string };
export type PeopleRefResolution = { ok: true; people: ResolvedPerson[] } | { ok: false; error: string };

/** One reference for a tool that needs a definite person (reminders, birthdays): fuzzy, with explanations. */
export function resolvePersonRef(ref: string, directory: PeopleDirectory): PersonRefResolution {
  const result = lookupPerson(directory, ref, { fuzzy: true });
  return result.ok ? result : { ok: false, error: explainLookupFailure(result, ref, directory) };
}

/** Every reference (deduplicated by member); the first failure aborts with its explanation. */
export function resolvePeopleRefs(refs: string[], directory: PeopleDirectory): PeopleRefResolution {
  const people: ResolvedPerson[] = [];
  for (const ref of refs) {
    const resolved = resolvePersonRef(ref, directory);
    if (!resolved.ok) return resolved;
    if (!people.some((p) => p.userId === resolved.person.userId)) people.push(resolved.person);
  }
  return { ok: true, people };
}

/** Who sent a message: its real author (a relayed repost counts as its member), by main account id. */
export function requesterOf(message: Message): ResolvedPerson {
  const attribution = attributeMessage(message);
  const displayName =
    attribution?.authorName || message.member?.displayName || message.author.displayName || message.author.username;
  const userId = attribution?.authorId ?? canonicalUserId(message.author.id);
  return { userId, displayName, names: [displayName] };
}

/** A member's current display name by any of their account ids, or `fallback` when nobody knows the id. */
export function currentName(userId: string, fallback: string, store?: MemoryStore): string {
  try {
    const memory = store ?? getMemoryStore();
    return (
      memory.getIdentityById(canonicalUserId(userId))?.display_name ??
      memory.getIdentityById(userId)?.display_name ??
      fallback
    );
  } catch {
    return fallback;
  }
}

/**
 * The getForPerson() key for a member: their main account id and every name any of their accounts
 * goes by (`extraNames`, e.g. a live display name, first). Rows saved before the subject_user_id
 * column existed, and some remember_fact rows, carry only a name — an old display name, the
 * first-seen name, an IRL name, a nickname or the Discord handle.
 */
export function memoryKeyFor(
  store: MemoryStore,
  userId: string,
  extraNames: (string | null | undefined)[] = [],
): { userId: string; names: string[] } {
  const main = canonicalUserId(userId);
  const rows: Identity[] = [];
  for (const id of accountIdsFor(main)) {
    try {
      const row = store.getIdentityById(id);
      if (row) rows.push(row);
    } catch (error) {
      logger.warn(`people: failed to read identity ${id}:`, error);
    }
  }
  return { userId: main, names: namesOfAll(rows, extraNames) };
}

// ---------------------------------------------------------------------------------------------------
// Finding people in chat text
// ---------------------------------------------------------------------------------------------------

/** A member referenced in text, with how many times. */
export type PersonReference = ResolvedPerson & { member: Member; count: number };

// Names shorter than this are never matched in free text ("Ed" would match every "ed" typo, "D" every
// ":D"). IRL names are the exception down to two letters: real names like "Yi" are that short.
const MIN_TEXT_NAME_LENGTH = 3;
const MIN_IRL_NAME_LENGTH = 2;
const MENTION_SPLIT = /(<@!?\d+>)/;
const MENTION_ID = /^<@!?(\d+)>$/;
// Blanked out before name matching: a handle inside a link ("twitter.com/jason/status/…"), an emoji
// name (<:jason:123>), role/channel mentions and timestamps are not references to a member.
const NOT_PROSE = /https?:\/\/\S+|<a?:\w+:\d+>|<[#@]&?!?\d+>|<t:-?\d+(?::\w)?>/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type PeopleMatcherOptions = {
  /** Names never matched (the bot's own names: "fridge, what do you think" addresses the bot, it discusses nobody). */
  excludeNames?: Iterable<string | null | undefined>;
};

/** The names text is matched against, per member, flagged when they are IRL names (shorter minimum). */
function textNamesOf(member: Member): { name: string; irl: boolean }[] {
  return member.rows
    .flatMap((row) => [
      ...[row.display_name, row.username, row.canonical_name, ...row.aliases].map((name) => ({ name, irl: false })),
      ...[row.irl_name, irlFirstName(row)].map((name) => ({ name, irl: true })),
    ])
    .filter(
      (entry): entry is { name: string; irl: boolean } => typeof entry.name === 'string' && entry.name.trim() !== '',
    );
}

function matcherFor(members: Member[], opts: PeopleMatcherOptions): (text: string) => Map<string, number> {
  const known = new Set(members.map((m) => m.userId));
  const excluded = new Set([...(opts.excludeNames ?? [])].map(nameKey).filter((key) => key.length > 0));
  const idByKey = new Map<string, string>();
  const checked = new Set<string>();
  for (const member of members) {
    for (const { name, irl } of textNamesOf(member)) {
      const key = nameKey(name);
      if ([...key].length < (irl ? MIN_IRL_NAME_LENGTH : MIN_TEXT_NAME_LENGTH)) continue;
      if (checked.has(key)) continue;
      checked.add(key);
      if (excluded.has(key) || STOP_WORDS.has(key) || CROWD_WORDS.has(key) || SELF_WORDS.has(key)) continue;
      // A name counts only when it names exactly one member at its strongest tier.
      const owner = matchMemberByName(members, name);
      if (owner) idByKey.set(key, owner.userId);
    }
  }

  // Longest names first so "Big Mike" wins over "Mike" at the same position; a multi-word name
  // matches across any run of whitespace.
  const alternatives = [...idByKey.keys()]
    .sort((a, b) => b.length - a.length)
    .map((key) => key.split(' ').map(escapeRegExp).join('\\s+'));
  const namePattern =
    alternatives.length > 0
      ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_])`, 'giu')
      : undefined;

  return (text: string) => {
    const counts = new Map<string, number>();
    const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
    // Left to right, so the map's order is the order people first come up in.
    for (const part of text.split(MENTION_SPLIT)) {
      const mention = part.match(MENTION_ID);
      if (mention) {
        const userId = canonicalUserId(mention[1]);
        if (known.has(userId)) bump(userId);
        continue;
      }
      if (!namePattern) continue;
      const prose = nameKey(part.replace(NOT_PROSE, ' '));
      for (const match of prose.matchAll(namePattern)) {
        const userId = idByKey.get(nameKey(match[0]));
        if (userId) bump(userId);
      }
    }
    return counts;
  };
}

/**
 * Builds a reusable matcher over the given identities (build it once to scan many messages): per main
 * account id, how many times the text refers to the member — `<@id>` mention tokens (a side account's
 * counts as its member) and whole-word, case- and accent-insensitive occurrences of any name they go by.
 * Skipped rather than guessed: names two members share at the same strength, names under three letters
 * (IRL names down to two), stop words, the bot's names, and anything inside URLs, emoji or mention tokens.
 * The map's order is the order people first come up in the text.
 */
export function createPeopleMatcher(
  identities: Identity[],
  opts: PeopleMatcherOptions = {},
): (text: string) => Map<string, number> {
  return matcherFor(foldMembers(identities), opts);
}

/** Turns per-member counts into references, most referenced first (ties: the order they came up in). */
export function toPersonReferences(counts: Map<string, number>, members: Member[]): PersonReference[] {
  const byId = new Map(members.map((m) => [m.userId, m]));
  const refs: PersonReference[] = [];
  for (const [userId, count] of counts) {
    const member = byId.get(userId);
    if (member) refs.push({ ...toResolved(member), member, count });
  }
  // Array.prototype.sort is stable, so equal counts keep their first-seen order.
  return refs.sort((a, b) => b.count - a.count);
}

/**
 * The members a piece of chat text refers to (see createPeopleMatcher), most referenced first, minus
 * `excludeUserIds` (any account id of theirs: the speaker, the bot). For many texts, build one
 * createPeopleMatcher() instead of calling this per text.
 */
export function findPeopleInText(
  store: MemoryStore,
  text: string,
  opts: PeopleMatcherOptions & { excludeUserIds?: Iterable<string> } = {},
): PersonReference[] {
  const members = foldMembers(store.getAllIdentities());
  const excluded = new Set([...(opts.excludeUserIds ?? [])].map((id) => canonicalUserId(id)));
  return toPersonReferences(matcherFor(members, opts)(text), members).filter((ref) => !excluded.has(ref.userId));
}
