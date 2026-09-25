// Prompt fragments shared by the chat agent and the personality learner, so the two never drift on
// how a person or an emoji is described to a model.
import { type EmojiRow, type Identity, nameKey } from './memory/memoryStore';
import { foldMembers } from './people';

const CUSTOM_EMOJI_PATTERN = /<(a?):(\w+):(\d+)>/g;

export type CustomEmojiRef = { name: string; id: string; animated: boolean };

/** Every `<:name:id>` / `<a:name:id>` token in the text, in order (duplicates included). */
export function findCustomEmojis(text: string): CustomEmojiRef[] {
  const refs: CustomEmojiRef[] = [];
  for (const match of text.matchAll(CUSTOM_EMOJI_PATTERN)) {
    refs.push({ animated: match[1] === 'a', name: match[2], id: match[3] });
  }
  return refs;
}

/** The exact chat syntax Discord needs to render a custom emoji. */
export function emojiSyntax(emoji: { name: string; id: string; animated: boolean | number }): string {
  return emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
}

/** Discord CDN URL of a custom emoji's image, sized for vision models. */
export function emojiCdnUrl(emojiId: string, animated: boolean): string {
  const ext = animated ? 'gif' : 'png';
  return `https://cdn.discordapp.com/emojis/${emojiId}.${ext}?size=96&quality=lossless`;
}

/** "Name @handle (id:…)", the handle left out when it is unknown or just the name again. */
function accountLabel(identity: Pick<Identity, 'display_name' | 'username' | 'discord_user_id'>): string {
  const handle =
    identity.username && nameKey(identity.username) !== nameKey(identity.display_name) ? ` @${identity.username}` : '';
  return `${identity.display_name}${handle} (id:${identity.discord_user_id})`;
}

/**
 * One bullet per member, current display name first (the name memories are filed under):
 * "Wheelie @wheelie_d (id:…) — real name Dorian; also called D, Wheels; formerly OldNick; also posts as
 * Alt @alt_handle (id:…)". A linked side account (LINKED_ACCOUNTS) is folded into its member's line and
 * never listed as a separate person. "formerly" is the first-seen display name, when it differs.
 */
export function formatIdentityLines(identities: Identity[]): string[] {
  return foldMembers(identities).map((member) => {
    const main = member.identity;
    const accounts = [...(main ? [main] : []), ...member.sideAccounts];
    const parts: string[] = [];
    const irlNames = [...new Set(accounts.map((i) => i.irl_name?.trim()).filter((n): n is string => Boolean(n)))];
    if (irlNames.length > 0) parts.push(`real name ${irlNames.join(' / ')}`);
    const aliases = [...new Set(accounts.flatMap((i) => i.aliases))];
    if (aliases.length > 0) parts.push(`also called ${aliases.join(', ')}`);
    const shown = new Set(accounts.flatMap((i) => [nameKey(i.display_name), nameKey(i.username)]));
    if (main && !shown.has(nameKey(main.canonical_name))) parts.push(`formerly ${main.canonical_name}`);
    if (member.sideAccounts.length > 0) parts.push(`also posts as ${member.sideAccounts.map(accountLabel).join(', ')}`);
    const head = main ? accountLabel(main) : `${member.displayName} (id:${member.userId})`;
    return `- ${head}${parts.length > 0 ? ` — ${parts.join('; ')}` : ''}`;
  });
}

/** One bullet per emoji: the exact syntax plus its caption when one exists. */
export function formatEmojiLines(emojis: EmojiRow[]): string[] {
  return emojis.map((e) => {
    const captionPart = e.caption ? ` — ${e.caption}` : '';
    return `- ${emojiSyntax(e)}${captionPart}`;
  });
}
