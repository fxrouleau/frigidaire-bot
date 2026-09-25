// "What does Fridge know?": the bot's memories about a person, newest first, with ids (what
// forget_memory takes) and ages — shown only to the invoker. Memories are matched by the person's stable
// Discord id or any of their known names, since older rows only carry a name.
import { type APIInteractionGuildMember, ApplicationCommandType, type GuildMember, escapeMarkdown } from 'discord.js';
import { type Memory, SELF_DIAGNOSIS_CATEGORIES } from '../ai/memory/memoryStore';
import { formatRelativeAge } from '../ai/utils';
import { DISCORD_MESSAGE_LIMIT, answerPrivately } from './respond';
import { personNames } from './targets';
import type { UserCommand } from './types';

export const MAX_LISTED_MEMORIES = 25;
// Enough to count everything about one person without an unbounded read.
const FETCH_LIMIT = 1000;
const MAX_CONTENT_CHARS = 200;
const SELF_DIAGNOSIS: ReadonlySet<string> = new Set(SELF_DIAGNOSIS_CATEGORIES);

export const whatDoesFridgeKnow: UserCommand = {
  type: ApplicationCommandType.User,
  name: 'What does Fridge know?',
  async run(interaction, deps) {
    const user = interaction.targetUser;
    const store = deps.memoryStore();
    const identity = store.getIdentityById(user.id);
    const name = memberName(interaction.targetMember) ?? identity?.display_name ?? user.displayName;

    const names = personNames(identity, name, user.displayName, user.username);
    const memories = store
      .getForPerson({ userId: user.id, names }, FETCH_LIMIT)
      .filter((m) => !SELF_DIAGNOSIS.has(m.category));

    if (memories.length === 0) {
      await answerPrivately(interaction, `I've got nothing on ${escapeMarkdown(name)} yet`);
      return;
    }
    await answerPrivately(interaction, renderMemoryList(name, memories, deps.now()));
  },
};

function memberName(member: GuildMember | APIInteractionGuildMember | null): string | undefined {
  if (!member) return undefined;
  if ('displayName' in member) return member.displayName;
  return member.nick ?? undefined;
}

/**
 * One message: a header, then the newest memories (up to 25) as `#id content (category, age)` lines —
 * as many as fit in 2000 characters. The header says how many are shown out of how many exist.
 */
export function renderMemoryList(name: string, memories: Memory[], now: Date): string {
  const header = (shown: number) =>
    shown < memories.length
      ? `**What I know about ${escapeMarkdown(name)}** (newest ${shown} of ${memories.length})`
      : `**What I know about ${escapeMarkdown(name)}** (${memories.length})`;

  const lines = memories.slice(0, MAX_LISTED_MEMORIES).map((m) => {
    const content = m.content.length > MAX_CONTENT_CHARS ? `${m.content.slice(0, MAX_CONTENT_CHARS - 1)}…` : m.content;
    const age = formatRelativeAge(m.updated_at, now);
    return `\`#${m.id}\` ${escapeMarkdown(content.replace(/\s+/g, ' '))} *(${m.category}${age ? `, ${age}` : ''})*`;
  });

  // Budget for the longest header this list can get ("newest 0 of N" plus a second digit), so the final
  // text never exceeds one message.
  const budget = DISCORD_MESSAGE_LIMIT - header(0).length - 2;
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + 1 + line.length > budget) break;
    kept.push(line);
    length += 1 + line.length;
  }
  return [header(kept.length), ...kept].join('\n');
}
