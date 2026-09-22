// Prompt fragments shared by the chat agent and the personality learner, so the two never drift on
// how a person or an emoji is described to a model.
import type { EmojiRow, Identity } from './memory/memoryStore';

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

/** One bullet per known member: "canonical (now: current) (id:...) — IRL: ... . Also called: ..." */
export function formatIdentityLines(identities: Identity[]): string[] {
  return identities.map((i) => {
    const namePart =
      i.canonical_name === i.display_name ? i.canonical_name : `${i.canonical_name} (now: ${i.display_name})`;
    const irlPart = i.irl_name ? ` — IRL: ${i.irl_name}` : '';
    const aliasPart = i.aliases.length > 0 ? `. Also called: ${i.aliases.join(', ')}` : '';
    return `- ${namePart} (id:${i.discord_user_id})${irlPart}${aliasPart}`;
  });
}

/** One bullet per emoji: the exact syntax plus its caption when one exists. */
export function formatEmojiLines(emojis: EmojiRow[]): string[] {
  return emojis.map((e) => {
    const captionPart = e.caption ? ` — ${e.caption}` : '';
    return `- ${emojiSyntax(e)}${captionPart}`;
  });
}
