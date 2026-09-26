// Some members post from a side account now and then. LINKED_ACCOUNTS maps each side account to the
// person's main account, and everything that keys on "who is this" (memories, attribution, the archive,
// the gate, reminders, birthdays) resolves ids through canonicalUserId() so the side account's messages
// count as the same person. The side account's own identity row still exists; it just never owns memories.
import { config } from './config';

/** The main account id for a side account; any other id is returned unchanged. */
export function canonicalUserId(userId: string): string;
export function canonicalUserId(userId: string | undefined): string | undefined;
export function canonicalUserId(userId: string | undefined): string | undefined {
  if (!userId) return userId;
  return config.server.linkedAccounts.get(userId) ?? userId;
}

/** Every account id that belongs to the same person as `userId` (the main id first). */
export function accountIdsFor(userId: string): string[] {
  const main = canonicalUserId(userId);
  const ids = [main];
  for (const [side, target] of config.server.linkedAccounts) {
    if (target === main && !ids.includes(side)) ids.push(side);
  }
  return ids;
}

/** True when two ids belong to the same person. */
export function isSamePerson(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return canonicalUserId(a) === canonicalUserId(b);
}
