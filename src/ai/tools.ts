import type { Message } from 'discord.js';
import { logger } from '../logger';
import { getMemoryStore } from './memory';
import {
  type Identity,
  type Memory,
  type MemoryStore,
  NON_PERSON_SUBJECTS,
  SELF_DIAGNOSIS_CATEGORIES,
  nameKey,
} from './memory/memoryStore';
import { type Member, type ResolvedPerson, cleanSubject, foldMembers, resolvePerson } from './people';
import { emojiSyntax } from './promptSections';
import { birthdayTools } from './tools/birthdays';
import { costTools } from './tools/costs';
import { featureRequestTools } from './tools/featureRequest';
import { linkReaderTools } from './tools/linkReader';
import { messageSearchTools } from './tools/messageSearch';
import { reactTools } from './tools/react';
import { reminderTools } from './tools/reminders';
import { sandboxTools } from './tools/sandbox';
import { runSummaryTool } from './tools/summary';
import type { ToolDefinition, ToolHandlerContext } from './types';

// The categories the chat model may write. Everything the model sends is untrusted text: a
// hallucinated 'Fact', 'image' or 'capability_gap' would create a never-expiring or self-diagnosis
// polluting row, so arguments are whitelisted here exactly like the learner whitelists its own.
const CHAT_MEMORY_CATEGORIES = ['fact', 'preference', 'personality', 'event', 'vibe'] as const;
type ChatMemoryCategory = (typeof CHAT_MEMORY_CATEGORIES)[number];

function parseCategory(raw: unknown): ChatMemoryCategory | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  return (CHAT_MEMORY_CATEGORIES as readonly string[]).includes(normalized)
    ? (normalized as ChatMemoryCategory)
    : undefined;
}

/** Parses a positive integer id from a number or numeric string; undefined for anything else. */
function parseId(raw: unknown): number | undefined {
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Parses an integer within [min, max], falling back to the default for anything else. */
function parseLimit(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function optionalString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatMemoryLine(m: Memory): string {
  return `[id:${m.id}] [${m.category}] ${m.subject}: ${m.content} (saved: ${m.created_at}, updated: ${m.updated_at})`;
}

/**
 * The member a tool's subject refers to (see resolvePerson). Tool contexts in tests may carry no
 * message; a store failure only costs the resolution, never the tool call.
 */
function resolveSubject(store: MemoryStore, subject: string, message: Message | undefined): ResolvedPerson | undefined {
  try {
    return resolvePerson(store, subject, message);
  } catch (error) {
    logger.warn(`Resolving memory subject "${subject}" failed:`, error);
    return undefined;
  }
}

/** A person's memories under every name they have had, or the rows filed under a plain subject. */
function memoriesAbout(
  store: MemoryStore,
  person: ResolvedPerson | undefined,
  subject: string,
  limit: number,
): Memory[] {
  return person
    ? store.getForPerson({ userId: person.userId, names: person.names }, limit)
    : store.getBySubject(subject, limit);
}

const summarizeTool: ToolDefinition = {
  name: 'summarize_messages',
  description:
    'Summarize what was said in this channel over a stretch of time ("catch me up", "what did I miss", "tldr of last night"). Times are Eastern wall-clock (America/New_York) written as \'YYYY-MM-DD HH:MM\'; work them out from the current Eastern time in your context. Vague phrases: "last night" ≈ 18:00 yesterday, "this morning" ≈ 06:00 today, "today" = since 00:00 today, "the last hour" = one hour before now. For "what did I miss" / "since I left", set since_my_last_message instead of guessing a time. Covers at most the last 7 days. The result ends with the people in that stretch.',
  parameters: {
    type: 'object',
    properties: {
      start_time: {
        type: 'string',
        description:
          "Start of the range, Eastern wall-clock 'YYYY-MM-DD HH:MM' (e.g. '2026-09-24 18:00'). Required unless since_my_last_message is true.",
      },
      end_time: {
        type: 'string',
        description: 'End of the range, Eastern wall-clock \'YYYY-MM-DD HH:MM\'. Omit for "until now".',
      },
      since_my_last_message: {
        type: 'boolean',
        description:
          'True to start from when the person asking was last active in this channel before now (their messages from the last few minutes do not count). start_time is then ignored.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => runSummaryTool(ctx.message, args),
};

// A real name or nickname the model passes to set_member_info: one short line of plain text.
const MAX_MEMBER_NAME_LENGTH = 48;

/** A name for set_member_info, or 'invalid' for anything that is not one (markup, mass pings, an essay). */
function parseMemberName(raw: unknown): string | undefined | 'invalid' {
  const value = optionalString(raw);
  if (!value) return undefined;
  if (/[<>\n]|@(everyone|here)\b|https?:/i.test(value)) return 'invalid';
  const name = cleanSubject(value).replace(/\s+/g, ' ');
  if (!name || name.length > MAX_MEMBER_NAME_LENGTH) return 'invalid';
  return name;
}

/**
 * Whether a nickname may be added to a member: not a word that names the group, not one of their own
 * names already, and not another member's display name, handle or first-seen name (lookups rank those
 * above nicknames, so it would never find this member anyway). Returns the refusal, or a note when the
 * nickname is also someone else's real name or nickname, or undefined when it is fine.
 */
function checkNickname(
  store: MemoryStore,
  userId: string,
  displayName: string,
  nickname: string,
): { refusal?: string; note?: string } {
  const key = nameKey(nickname);
  if (NON_PERSON_SUBJECTS.has(key) || ['me', 'i', 'myself'].includes(key)) {
    return { refusal: `"${nickname}" can't be a nickname.` };
  }
  // Members, not accounts: a name one of their own side accounts goes by is theirs already.
  const members = foldMembers(store.getAllIdentities());
  const own = members.find((m) => m.userId === userId);
  if ([displayName, ...(own?.names ?? [])].some((n) => nameKey(n) === key)) {
    return { refusal: `${displayName} already goes by "${nickname}".` };
  }
  const others = members.filter((m) => m.userId !== userId);
  const goesBy = (member: Member, names: (i: Identity) => (string | null | undefined)[]) =>
    member.rows.some((row) => names(row).some((n) => nameKey(n) === key));
  const owner = others.find((m) => goesBy(m, (i) => [i.display_name, i.username, i.canonical_name]));
  if (owner) {
    return {
      refusal: `"${nickname}" is ${owner.displayName}'s own name, so it can't also be ${displayName}'s nickname.`,
    };
  }
  const sharer = others.find((m) => goesBy(m, (i) => [i.irl_name, ...i.aliases]));
  return sharer
    ? { note: `${sharer.displayName} also goes by "${nickname}", so that name alone won't tell them apart.` }
    : {};
}

const setMemberInfoTool: ToolDefinition = {
  name: 'set_member_info',
  description:
    'Record a member\'s real name or a nickname the group uses for them, when someone tells you ("fridge, Yi\'s real name is Yi", "we call Derrick D"). This is how you recognize people by every name they go by. Display names and Discord handles update on their own: never use this for those, for jokes, or for one-off insults.',
  parameters: {
    type: 'object',
    properties: {
      person: {
        type: 'string',
        description: 'Who: any name they go by (display name, handle, real name, nickname), an @mention, or "me".',
      },
      real_name: { type: 'string', description: 'Their real-life name. Replaces the one on record.' },
      add_nickname: { type: 'string', description: 'A nickname the group uses for them, added to the ones on record.' },
    },
    required: ['person'],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const rawPerson = optionalString(args.person);
    if (!rawPerson) return 'Say who: person was empty.';
    const realName = parseMemberName(args.real_name);
    const nickname = parseMemberName(args.add_nickname);
    if (realName === 'invalid' || nickname === 'invalid') {
      return `Names must be plain text up to ${MAX_MEMBER_NAME_LENGTH} characters (no mentions, links or line breaks).`;
    }
    if (!realName && !nickname) return 'Nothing to update: give real_name and/or add_nickname.';

    const store = getMemoryStore();
    const person = resolveSubject(store, rawPerson, ctx.message);
    if (!person) {
      return `I don't know who "${rawPerson}" is. Use a name they go by or @mention them.`;
    }

    // A member @-mentioned before they ever posted has no identity row yet.
    if (!store.getIdentityById(person.userId)) store.upsertIdentity(person.userId, person.displayName);
    const before = store.getIdentityById(person.userId);

    const results: string[] = [];
    const notes: string[] = [];
    let aliasToAdd: string | undefined;
    if (nickname) {
      const check = checkNickname(store, person.userId, person.displayName, nickname);
      if (check.refusal) notes.push(check.refusal);
      else aliasToAdd = nickname;
      if (check.note) notes.push(check.note);
    }

    const changed = store.updateIdentityMeta(person.userId, {
      irl_name: realName,
      aliases_add: aliasToAdd ? [aliasToAdd] : [],
    });
    if (realName) {
      results.push(
        before?.irl_name === realName
          ? `real name was already ${realName}`
          : `real name is now ${realName}${before?.irl_name ? ` (was ${before.irl_name})` : ''}`,
      );
    }
    if (aliasToAdd) results.push(`added nickname "${aliasToAdd}"`);

    // Identity edits change how every later lookup resolves names: leave an audit line.
    if (changed) logger.info(`set_member_info: ${person.displayName} (${person.userId}): ${results.join(', ')}`);
    const summary =
      results.length > 0
        ? `${person.displayName}: ${results.join('; ')}.`
        : `Nothing changed for ${person.displayName}.`;
    return [summary, ...notes].join(' ');
  },
};

const imageTool: ToolDefinition = {
  name: 'generate_image',
  description:
    'Generate an image from a prompt. If refine_previous is true, improve the most recently generated image for this channel using the refinement text.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'A detailed description of the image to generate.',
      },
      refine_previous: {
        type: 'boolean',
        description: 'If true, refine the most recently generated image for this channel.',
      },
      source_image_url: {
        type: 'string',
        description:
          'URL of an image from the conversation to use as reference/source for the generation. Pass this when the user wants to transform, edit, or reference an existing image.',
      },
    },
    required: ['prompt', 'refine_previous'],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    if (!ctx.provider.generateImage) {
      return 'This provider does not support image generation.';
    }
    const prompt = String(args.prompt ?? '');
    const refinePrevious = args.refine_previous === true || args.refine_previous === 'true';
    const sourceImageUrl = optionalString(args.source_image_url);
    return ctx.provider.generateImage(ctx.message, prompt, { refinePrevious, sourceImageUrl, turn: ctx.turn });
  },
};

const rememberFactTool: ToolDefinition = {
  name: 'remember_fact',
  description:
    'Save something to long-term memory. Categories: "fact" (names, jobs, locations), "preference" (likes/dislikes), "personality" (communication style), "event" (something that happened — expires automatically after ~2 weeks; use "fact" for anything that should be remembered permanently), "vibe" (server culture, in-jokes).',
  parameters: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: [...CHAT_MEMORY_CATEGORIES] },
      subject: {
        type: 'string',
        description:
          'Who/what this is about: the person\'s display name (a nickname, real name, or "me" for whoever is talking also works — it is matched to the member), or "server" for the group.',
      },
      content: { type: 'string', description: 'What to remember. Be concise.' },
    },
    required: ['category', 'subject', 'content'],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const category = parseCategory(args.category);
    if (!category) {
      return `Invalid category "${String(args.category)}". Use one of: ${CHAT_MEMORY_CATEGORIES.join(', ')}.`;
    }
    const content = optionalString(args.content);
    if (!content) {
      return 'Nothing to remember: content was empty.';
    }
    const rawSubject = optionalString(args.subject) ?? 'general';

    const store = getMemoryStore();
    // A person's memories are keyed by their Discord id and filed under their CURRENT display name, so
    // "Derrick", "@Wheezer" and "me" all land on the same member and survive renames. Anything else
    // ('server', a topic, someone the bot has never seen) is kept as written.
    const person = resolveSubject(store, rawSubject, ctx.message);
    const cleaned = cleanSubject(rawSubject) || rawSubject;
    const subject = person?.displayName ?? (NON_PERSON_SUBJECTS.has(nameKey(cleaned)) ? nameKey(cleaned) : cleaned);
    const id = await store.save({
      category,
      subject,
      content,
      source: 'conversation',
      subject_user_id: person?.userId,
    });
    return person ? `Saved to memory (id: ${id}) about ${person.displayName}.` : `Saved to memory (id: ${id}).`;
  },
};

const recallMemoriesTool: ToolDefinition = {
  name: 'recall_memories',
  description:
    'Search long-term memory: facts, preferences, personality, events, and server vibe. Use when someone references the past, for "what do you know about X" questions, to check what you know before asking, or to find the id of a memory you need to update or forget. Searches by subject name, topic keywords, and category. Bot self-diagnosis entries (capability gaps, errors, improvement ideas) are not included — use query_self_diagnosis for those.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "What to search for — a person's name, a topic, an event, etc." },
      subject: {
        type: 'string',
        description: 'Optional: filter by person (any name they go by, or "me") or "server".',
      },
      category: {
        type: 'string',
        enum: [...CHAT_MEMORY_CATEGORIES, 'all'],
        description: 'Optional category filter. Use "all" or omit to search everything.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const store = getMemoryStore();
    const query = optionalString(args.query) ?? '';
    const subject = optionalString(args.subject);
    const category = args.category === 'all' ? undefined : parseCategory(args.category);

    const results: Memory[] = [];
    const seenIds = new Set<number>();
    const add = (rows: Memory[]) => {
      for (const row of rows) {
        if (category && row.category !== category) continue;
        if (seenIds.has(row.id)) continue;
        seenIds.add(row.id);
        results.push(row);
      }
    };

    // 1. Person-keyed rows first: an explicit subject filter, then the query itself read as a name. A
    //    name that resolves to a member pulls their memories by id and under every name they've had.
    if (subject) add(memoriesAbout(store, resolveSubject(store, subject, ctx.message), subject, 20));
    if (query) add(memoriesAbout(store, resolveSubject(store, query, ctx.message), query, 20));

    // 2. Hybrid (semantic + keyword) search for topic matches.
    if (query) {
      try {
        add(await store.search(query, 20));
      } catch (error) {
        // Search may fail (e.g. embeddings and FTS both unavailable); fall back to subject-only results.
        logger.warn('recall_memories: search failed, returning subject matches only:', error);
      }
    }

    // 3. A category filter with few hits widens to the category's most recent rows.
    if (category && results.length < 5) add(store.getByCategory(category, 20));

    if (results.length === 0) {
      return 'No memories found matching that query.';
    }

    return `Found ${results.length} memories:\n${results.slice(0, 25).map(formatMemoryLine).join('\n')}`;
  },
};

const forgetMemoryTool: ToolDefinition = {
  name: 'forget_memory',
  description:
    "Remove a memory that's been superseded by a correction, is now wrong, or that someone explicitly asked you to forget. Call recall_memories first to get its id. Don't forget memories over jokes or banter.",
  parameters: {
    type: 'object',
    properties: {
      memory_id: { type: 'number', description: 'The memory ID from recall_memories.' },
      reason: { type: 'string', description: 'Why.' },
    },
    required: ['memory_id'],
    additionalProperties: false,
  },
  handler: async (_ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const id = parseId(args.memory_id);
    if (id === undefined) {
      return 'Invalid memory ID.';
    }
    const forgotten = getMemoryStore().deactivate(id);
    return forgotten ? `Memory #${id} has been forgotten.` : `No active memory with id ${id} — nothing to forget.`;
  },
};

const querySelfDiagnosisTool: ToolDefinition = {
  name: 'query_self_diagnosis',
  description:
    'Check what the bot has been struggling with or what could be improved. Use when asked "what have you been struggling with?", "what should we improve?", "any issues lately?", "what are your pain points?". Entries are prefixed with [id:N]; pass an id to forget_memory to remove one.',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: [...SELF_DIAGNOSIS_CATEGORIES, 'all'],
        description: 'Filter by type of issue. Use "all" to see everything.',
      },
      limit: {
        type: 'number',
        description: 'Max results to return. Default 15.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (_ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const store = getMemoryStore();
    const requested = optionalString(args.category);
    const category =
      requested && requested !== 'all' && (SELF_DIAGNOSIS_CATEGORIES as readonly string[]).includes(requested)
        ? requested
        : undefined;
    const limit = parseLimit(args.limit, 15, 1, 50);

    let results: Memory[] = [];

    if (category) {
      results = store.getByCategory(category, limit * 3);
    } else {
      for (const cat of SELF_DIAGNOSIS_CATEGORIES) {
        results.push(...store.getByCategory(cat, limit * 3));
      }
    }

    // Filter to only bot-related subjects FIRST, then sort and slice
    results = results.filter((r) => r.subject === 'bot' || r.subject === 'server');
    results.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    results = results.slice(0, limit);

    if (results.length === 0) {
      return "No self-diagnosis data found yet. The bot hasn't logged any issues or improvement ideas.";
    }

    // [id:N] prefixes keep forget_memory usable for self-diagnosis entries — search() excludes these
    // categories, so this tool is their only discovery path.
    const formatted = results.map((m) => `[id:${m.id}] [${m.category}] ${m.content} (${m.updated_at})`).join('\n');

    return `Self-diagnosis (${results.length} entries):\n${formatted}`;
  },
};

const getEmojiTool: ToolDefinition = {
  name: 'get_emoji',
  description:
    'Look up a server custom emoji by name or by the reaction you want, and get the exact syntax to post it. Only call this once you have already decided that a single emoji IS the reply or the punchline — most replies never need one.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Emoji name or the reaction you want, e.g. "trolle" or "panic".' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (_ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const query = (optionalString(args.query) ?? '').toLowerCase();
    if (!query) return 'No matching emoji. Reply in plain text.';
    const hits = getMemoryStore()
      .getUsableEmojis()
      .filter((e) => e.name.toLowerCase().includes(query) || (e.caption ?? '').toLowerCase().includes(query))
      .slice(0, 5);
    if (hits.length === 0) return 'No matching emoji. Reply in plain text.';
    return hits.map((e) => `${emojiSyntax(e)} — ${e.caption ?? e.name}`).join('\n');
  },
};

// Every tool the chat model can call. Feature tools live in their own modules under ./tools/ so each
// feature owns its file; a tool with an `isEnabled` gate is only offered when its feature is configured.
export const toolDefinitions: ToolDefinition[] = [
  summarizeTool,
  imageTool,
  rememberFactTool,
  recallMemoriesTool,
  forgetMemoryTool,
  setMemberInfoTool,
  querySelfDiagnosisTool,
  getEmojiTool,
  ...reactTools,
  ...reminderTools,
  ...birthdayTools,
  ...messageSearchTools,
  ...linkReaderTools,
  ...sandboxTools,
  ...featureRequestTools,
  ...costTools,
];
