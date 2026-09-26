// Who is who in a memory bootstrap export (docs/memory.md "Bootstrap"). Transcript lines name people by
// their current display name only (ids never appear per line: they cost tokens and mean nothing to a
// reader); people.json maps each of those names to the member's main id, every other name they went by
// and their linked accounts. Members come from the identities table (LINKED_ACCOUNTS folded in) plus
// everyone the archive holds messages from, so people who left before the bot ever saw them are covered
// too, under the last name they posted with.
import type { ArchiveStore } from '../../../archive/archiveStore';
import { accountIdsFor, canonicalUserId } from '../../../linkedAccounts';
import { foldMembers, type Member, matchMemberByName } from '../../people';
import { type MemoryStore, nameKey } from '../memoryStore';
import { easternDay } from './dates';

/** One member as the export names them. */
export type ExportPerson = {
  /** The name transcript lines use: their current display name, unique within the export. */
  name: string;
  /** Main account id. */
  id: string;
  /** Every account id (main first, then linked side accounts). */
  accounts: string[];
  realName: string | null;
  nicknames: string[];
  /** Every other name they went by (handle, first-seen name, names archived with their messages). */
  otherNames: string[];
  /** Member messages in the export (their relays included). */
  messages: number;
  firstMessageAt: number | null;
  lastMessageAt: number | null;
  /** The bot has an identities row for them (it has seen them); false for people only the archive knows. */
  known: boolean;
};

export type ExportPeople = {
  /** Most messages first. */
  people: ExportPerson[];
  /** An archived name without an account id (old relays, integrations' leftovers): its label and count. */
  unresolved: { name: string; label: string; messages: number }[];
  /** The bot's own account ids (its lines read `bot:`). */
  botIds: ReadonlySet<string>;
  /** The person any account id belongs to. */
  byAccount(id: string): ExportPerson | undefined;
  /** The label of a message's author: a person's export name, an unresolved name's label, or 'bot'. */
  authorOf(message: { authorId: string | null; authorName: string; source: string }): string;
};

/** The label the bot's own lines carry. */
export const BOT_LABEL = 'bot';

type ArchivedAuthor = { names: Map<string, number>; count: number; firstAt: number; lastAt: number };

/** A name as a transcript label: one line, no colon (the `Name: text` separator), trimmed. */
export function cleanLabel(raw: string): string {
  return raw
    .replace(/[:\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(nameKey(trimmed))) continue;
    seen.add(nameKey(trimmed));
    out.push(trimmed);
  }
  return out;
}

/**
 * The export's people: every member (identities, side accounts folded into their main) and every
 * account the archive holds member messages from, named by their current display name (the last name
 * they posted with when the bot never saw them), made unique by handle or a number.
 */
export function buildExportPeople(memory: MemoryStore, archive: ArchiveStore): ExportPeople {
  const members = foldMembers(memory.getAllIdentities());
  const memberById = new Map(members.map((m) => [m.userId, m]));

  const authors = new Map<string, ArchivedAuthor>();
  const unresolvedCounts = new Map<string, { name: string; messages: number }>();
  const botIds = new Set<string>();
  for (const row of archive.authorSummary()) {
    if (row.bot) {
      if (row.authorId) botIds.add(row.authorId);
      continue;
    }
    let id = row.authorId ? canonicalUserId(row.authorId) : undefined;
    // An archived name without an id: an old relay whose author was only known by name. It counts as the
    // member only when exactly one member goes by that name.
    if (!id) id = matchMemberByName(members, row.authorName)?.userId;
    if (!id) {
      const key = nameKey(row.authorName);
      const entry = unresolvedCounts.get(key) ?? { name: row.authorName, messages: 0 };
      entry.messages += row.count;
      unresolvedCounts.set(key, entry);
      continue;
    }
    const author = authors.get(id) ?? { names: new Map(), count: 0, firstAt: row.firstAt, lastAt: row.lastAt };
    author.count += row.count;
    author.firstAt = Math.min(author.firstAt, row.firstAt);
    author.lastAt = Math.max(author.lastAt, row.lastAt);
    author.names.set(row.authorName, Math.max(author.names.get(row.authorName) ?? 0, row.lastAt));
    authors.set(id, author);
  }

  const ids = new Set([...memberById.keys(), ...authors.keys()]);
  const drafts = [...ids].map((id) => {
    const member: Member | undefined = memberById.get(id);
    const author = authors.get(id);
    const latestArchived = author
      ? [...author.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
      : undefined;
    const base = cleanLabel(member?.displayName ?? latestArchived ?? '') || 'member';
    const identities = member ? [...(member.identity ? [member.identity] : []), ...member.sideAccounts] : [];
    const realName = identities.map((i) => i.irl_name?.trim()).find((n): n is string => Boolean(n)) ?? null;
    return {
      id,
      base,
      handle: member?.identity?.username ?? undefined,
      accounts: accountIdsFor(id),
      realName,
      nicknames: unique(identities.flatMap((i) => i.aliases)),
      names: unique([...(member?.names ?? []), ...(author ? [...author.names.keys()] : [])]),
      messages: author?.count ?? 0,
      firstMessageAt: author?.firstAt ?? null,
      lastMessageAt: author?.lastAt ?? null,
      known: member?.identity !== undefined,
    };
  });
  // The most active keep their plain name when two people share one.
  drafts.sort((a, b) => b.messages - a.messages || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const taken = new Set<string>([nameKey(BOT_LABEL)]);
  const claim = (candidates: string[]): string => {
    for (const candidate of candidates) {
      if (!taken.has(nameKey(candidate))) {
        taken.add(nameKey(candidate));
        return candidate;
      }
    }
    for (let n = 2; ; n++) {
      const numbered = `${candidates[0]} (${n})`;
      if (!taken.has(nameKey(numbered))) {
        taken.add(nameKey(numbered));
        return numbered;
      }
    }
  };

  const people: ExportPerson[] = drafts.map((d) => {
    const handle = d.handle ? cleanLabel(d.handle) : '';
    const name = claim([d.base, ...(handle && nameKey(handle) !== nameKey(d.base) ? [`${d.base} (@${handle})`] : [])]);
    return {
      name,
      id: d.id,
      accounts: d.accounts,
      realName: d.realName,
      nicknames: d.nicknames,
      otherNames: d.names.filter((n) => nameKey(n) !== nameKey(name) && nameKey(n) !== nameKey(d.base)),
      messages: d.messages,
      firstMessageAt: d.firstMessageAt,
      lastMessageAt: d.lastMessageAt,
      known: d.known,
    };
  });

  const unresolved = [...unresolvedCounts.values()]
    .sort((a, b) => b.messages - a.messages)
    .map((u) => {
      const base = cleanLabel(u.name) || 'someone';
      return { name: u.name, label: claim([base, `${base} (?)`]), messages: u.messages };
    });

  const byAccount = new Map<string, ExportPerson>();
  for (const person of people) for (const account of person.accounts) byAccount.set(account, person);
  const unresolvedLabel = new Map(unresolved.map((u) => [nameKey(u.name), u.label]));
  const memberByName = (name: string) => {
    const match = matchMemberByName(members, name);
    return match ? byAccount.get(match.userId) : undefined;
  };

  return {
    people,
    unresolved,
    botIds,
    byAccount: (id) => byAccount.get(id) ?? byAccount.get(canonicalUserId(id)),
    authorOf(message) {
      if (message.source === 'bot' || (message.authorId && botIds.has(message.authorId))) return BOT_LABEL;
      if (message.authorId) {
        const person = byAccount.get(canonicalUserId(message.authorId));
        if (person) return person.name;
      }
      return (
        memberByName(message.authorName)?.name ??
        unresolvedLabel.get(nameKey(message.authorName)) ??
        (cleanLabel(message.authorName) || 'someone')
      );
    },
  };
}

function isoDay(ms: number | null): string | null {
  return ms === null ? null : easternDay(ms);
}

/**
 * people.json: each transcript name mapped to the member's main id, their accounts and every other name,
 * so readers can name people in notes and observations by id while the transcripts stay compact.
 */
export function peopleJson(people: ExportPeople): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const p of people.people) {
    entries[p.name] = {
      id: p.id,
      accounts: p.accounts,
      real_name: p.realName,
      nicknames: p.nicknames,
      other_names: p.otherNames,
      messages: p.messages,
      first_message: isoDay(p.firstMessageAt),
      last_message: isoDay(p.lastMessageAt),
      known_to_bot: p.known,
    };
  }
  return {
    format: 'frigidaire-people',
    version: 1,
    about:
      'Transcript lines name people by these keys. Notes and observations name people by "id" (the main account id); "accounts" are every account of the same person. "bot" is Frigidaire itself.',
    people: entries,
    unresolved_names: people.unresolved.map((u) => ({ label: u.label, messages: u.messages })),
  };
}
