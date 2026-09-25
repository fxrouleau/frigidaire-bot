// Scenario file for the persona eval (scenarios.json next to this file): a fictional cast standing in
// for the group, the server's custom emojis, and one situation per scenario — what the bot remembers,
// what was said before, the message that pings it, and what a good reply looks like.
//
// Message text can mention people as `<@Name>` (a cast member) or `<@bot>`; the runner rewrites those
// into real `<@id>` mention tokens. Custom emojis are written as Discord renders them (`<:name:id>`) and
// must use an id from the emoji list, so a typo fails loading instead of silently testing nothing.
//
// Everything here is invented: the repository is public, so no real chat content or member details.
import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_SCENARIOS_PATH = path.join(__dirname, 'scenarios.json');

/** The author name for the bot's own earlier messages in `history`. */
export const BOT_AUTHOR = 'bot';

// The categories the bot itself writes for people (remember_fact's whitelist).
export const MEMORY_CATEGORIES = ['fact', 'preference', 'personality', 'event', 'vibe'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export type CastMember = { name: string; id: string; username: string; irlName?: string; aliases: string[] };
export type SeedMemory = { category: MemoryCategory; subject: string; content: string };
export type SeedEmoji = { id: string; name: string; caption?: string; animated: boolean };
export type SeedEmbed = { title?: string; description?: string; url?: string; imageUrl?: string };
export type ScenarioMessage = { author: string; content: string; minutesAgo: number; embeds: SeedEmbed[] };

export type Expectations = {
  /** What a great reply does — shown to the judge as the scenario's intent. */
  notes: string;
  maxChars?: number;
  minChars?: number;
  maxSentences?: number;
  /** Custom server emojis allowed in the reply (default 1: the guardrail's own ceiling). */
  maxCustomEmojis: number;
  /** Case-insensitive regexes that must each match the reply. */
  mustMatch: string[];
  /** Case-insensitive regexes none of which may match the reply. */
  mustNotMatch: string[];
  /** Checks on the memory store after the turn ("subject: content" lines of active memories). */
  memoryAfter?: { activeMustMatch: string[]; activeMustNotMatch: string[] };
};

export type Scenario = {
  id: string;
  title: string;
  tags: string[];
  memories: SeedMemory[];
  /** Oldest first, as the channel reads. */
  history: ScenarioMessage[];
  /** The message that pings the bot (posted "now"). */
  message: Omit<ScenarioMessage, 'minutesAgo'>;
  expectations: Expectations;
};

export type ScenarioFile = {
  version: 1;
  bot: { name: string; id: string };
  cast: CastMember[];
  emojis: SeedEmoji[];
  /** Server-wide memories seeded into every scenario. */
  sharedMemories: SeedMemory[];
  scenarios: Scenario[];
};

export class ScenarioFileError extends Error {}

type Json = Record<string, unknown>;

// A tiny path-tracking reader: every error names the exact field (`scenarios[3].history[1].author`).
function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(at: string, message: string): never {
  throw new ScenarioFileError(`${at}: ${message}`);
}

function object(value: unknown, at: string): Json {
  if (!isObject(value)) fail(at, 'expected an object');
  return value;
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) fail(at, 'expected an array');
  return value;
}

function optionalArray(value: unknown, at: string): unknown[] {
  return value === undefined ? [] : array(value, at);
}

function string(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(at, 'expected a non-empty string');
  return value;
}

function optionalString(value: unknown, at: string): string | undefined {
  return value === undefined ? undefined : string(value, at);
}

function optionalCount(value: unknown, at: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail(at, 'expected a non-negative integer');
  return value;
}

function regexList(value: unknown, at: string): string[] {
  return optionalArray(value, at).map((entry, i) => {
    const source = string(entry, `${at}[${i}]`);
    try {
      new RegExp(source, 'i');
    } catch (error) {
      fail(`${at}[${i}]`, `invalid regex (${error instanceof Error ? error.message : String(error)})`);
    }
    return source;
  });
}

function parseCast(value: unknown): CastMember[] {
  const seenNames = new Set<string>();
  const seenIds = new Set<string>();
  return array(value, 'cast').map((raw, i) => {
    const at = `cast[${i}]`;
    const entry = object(raw, at);
    const name = string(entry.name, `${at}.name`);
    const id = string(entry.id, `${at}.id`);
    if (!/^\d{17,20}$/.test(id)) fail(`${at}.id`, 'expected a Discord snowflake (17-20 digits)');
    if (seenNames.has(name.toLowerCase())) fail(`${at}.name`, `duplicate name "${name}"`);
    if (seenIds.has(id)) fail(`${at}.id`, `duplicate id "${id}"`);
    if (name.toLowerCase() === BOT_AUTHOR) fail(`${at}.name`, `"${BOT_AUTHOR}" is reserved for the bot`);
    seenNames.add(name.toLowerCase());
    seenIds.add(id);
    return {
      name,
      id,
      username: optionalString(entry.username, `${at}.username`) ?? name.toLowerCase(),
      irlName: optionalString(entry.irlName, `${at}.irlName`),
      aliases: optionalArray(entry.aliases, `${at}.aliases`).map((a, j) => string(a, `${at}.aliases[${j}]`)),
    };
  });
}

function parseEmojis(value: unknown): SeedEmoji[] {
  return optionalArray(value, 'emojis').map((raw, i) => {
    const at = `emojis[${i}]`;
    const entry = object(raw, at);
    const id = string(entry.id, `${at}.id`);
    if (!/^\d{17,20}$/.test(id)) fail(`${at}.id`, 'expected a Discord snowflake (17-20 digits)');
    return {
      id,
      name: string(entry.name, `${at}.name`),
      caption: optionalString(entry.caption, `${at}.caption`),
      animated: entry.animated === true,
    };
  });
}

function parseMemories(value: unknown, at: string, subjects: Set<string>): SeedMemory[] {
  return optionalArray(value, at).map((raw, i) => {
    const here = `${at}[${i}]`;
    const entry = object(raw, here);
    const category = string(entry.category, `${here}.category`);
    if (!(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
      fail(`${here}.category`, `expected one of ${MEMORY_CATEGORIES.join(', ')}`);
    }
    const subject = string(entry.subject, `${here}.subject`);
    if (!subjects.has(subject.toLowerCase())) fail(`${here}.subject`, `unknown subject "${subject}"`);
    return { category: category as MemoryCategory, subject, content: string(entry.content, `${here}.content`) };
  });
}

function parseEmbeds(value: unknown, at: string): SeedEmbed[] {
  return optionalArray(value, at).map((raw, i) => {
    const here = `${at}[${i}]`;
    const entry = object(raw, here);
    const embed: SeedEmbed = {
      title: optionalString(entry.title, `${here}.title`),
      description: optionalString(entry.description, `${here}.description`),
      url: optionalString(entry.url, `${here}.url`),
      imageUrl: optionalString(entry.imageUrl, `${here}.imageUrl`),
    };
    if (!embed.title && !embed.description && !embed.imageUrl) fail(here, 'an embed needs a title, description or image');
    return embed;
  });
}

type RefCheck = { castNames: Set<string>; emojiIds: Set<string> };

function checkReferences(content: string, at: string, refs: RefCheck): void {
  for (const match of content.matchAll(/<@!?([^>]+)>/g)) {
    const name = match[1];
    if (/^\d+$/.test(name)) fail(at, `write mentions as <@Name> or <@${BOT_AUTHOR}>, not raw ids (${match[0]})`);
    if (name !== BOT_AUTHOR && !refs.castNames.has(name.toLowerCase())) fail(at, `unknown mention ${match[0]}`);
  }
  for (const match of content.matchAll(/<a?:(\w+):(\d+)>/g)) {
    if (!refs.emojiIds.has(match[2])) fail(at, `emoji ${match[0]} is not in the emoji list`);
  }
}

function parseMessage(raw: unknown, at: string, refs: RefCheck, withAge: boolean): ScenarioMessage {
  const entry = object(raw, at);
  const author = string(entry.author, `${at}.author`);
  if (author !== BOT_AUTHOR && !refs.castNames.has(author.toLowerCase())) fail(`${at}.author`, `unknown author "${author}"`);
  const content = typeof entry.content === 'string' ? entry.content : fail(`${at}.content`, 'expected a string');
  checkReferences(content, `${at}.content`, refs);
  const embeds = parseEmbeds(entry.embeds, `${at}.embeds`);
  if (content.trim().length === 0 && embeds.length === 0) fail(at, 'a message needs content or an embed');
  let minutesAgo = 0;
  if (withAge) {
    const age = entry.minutesAgo;
    if (typeof age !== 'number' || !Number.isFinite(age) || age <= 0) fail(`${at}.minutesAgo`, 'expected a positive number');
    minutesAgo = age;
  }
  return { author, content, minutesAgo, embeds };
}

function parseExpectations(raw: unknown, at: string): Expectations {
  const entry = object(raw, at);
  const memoryAfterRaw = entry.memoryAfter === undefined ? undefined : object(entry.memoryAfter, `${at}.memoryAfter`);
  const expectations: Expectations = {
    notes: string(entry.notes, `${at}.notes`),
    maxChars: optionalCount(entry.maxChars, `${at}.maxChars`),
    minChars: optionalCount(entry.minChars, `${at}.minChars`),
    maxSentences: optionalCount(entry.maxSentences, `${at}.maxSentences`),
    maxCustomEmojis: optionalCount(entry.maxCustomEmojis, `${at}.maxCustomEmojis`) ?? 1,
    mustMatch: regexList(entry.mustMatch, `${at}.mustMatch`),
    mustNotMatch: regexList(entry.mustNotMatch, `${at}.mustNotMatch`),
    memoryAfter: memoryAfterRaw && {
      activeMustMatch: regexList(memoryAfterRaw.activeMustMatch, `${at}.memoryAfter.activeMustMatch`),
      activeMustNotMatch: regexList(memoryAfterRaw.activeMustNotMatch, `${at}.memoryAfter.activeMustNotMatch`),
    },
  };
  if (
    expectations.minChars !== undefined &&
    expectations.maxChars !== undefined &&
    expectations.minChars > expectations.maxChars
  ) {
    fail(at, 'minChars is larger than maxChars');
  }
  return expectations;
}

/** Validates a parsed scenario file. Throws ScenarioFileError naming the offending field. */
export function parseScenarioFile(raw: unknown): ScenarioFile {
  const root = object(raw, 'root');
  if (root.version !== 1) fail('version', `unsupported version ${JSON.stringify(root.version)} (expected 1)`);

  const botRaw = object(root.bot, 'bot');
  const bot = { name: string(botRaw.name, 'bot.name'), id: string(botRaw.id, 'bot.id') };
  const cast = parseCast(root.cast);
  const emojis = parseEmojis(root.emojis);
  const refs: RefCheck = {
    castNames: new Set(cast.map((c) => c.name.toLowerCase())),
    emojiIds: new Set(emojis.map((e) => e.id)),
  };
  const subjects = new Set([...refs.castNames, 'server']);
  const sharedMemories = parseMemories(root.sharedMemories, 'sharedMemories', subjects);

  const seenIds = new Set<string>();
  const scenarios = array(root.scenarios, 'scenarios').map((rawScenario, i): Scenario => {
    const at = `scenarios[${i}]`;
    const entry = object(rawScenario, at);
    const id = string(entry.id, `${at}.id`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail(`${at}.id`, 'expected a kebab-case id');
    if (seenIds.has(id)) fail(`${at}.id`, `duplicate scenario id "${id}"`);
    seenIds.add(id);
    const message = parseMessage(entry.message, `${at}.message`, refs, false);
    if (message.author === BOT_AUTHOR) fail(`${at}.message.author`, 'the triggering message must come from a person');
    return {
      id,
      title: string(entry.title, `${at}.title`),
      tags: optionalArray(entry.tags, `${at}.tags`).map((t, j) => string(t, `${at}.tags[${j}]`)),
      memories: parseMemories(entry.memories, `${at}.memories`, subjects),
      history: optionalArray(entry.history, `${at}.history`).map((m, j) =>
        parseMessage(m, `${at}.history[${j}]`, refs, true),
      ),
      message: { author: message.author, content: message.content, embeds: message.embeds },
      expectations: parseExpectations(entry.expectations, `${at}.expectations`),
    };
  });
  if (scenarios.length === 0) fail('scenarios', 'expected at least one scenario');

  return { version: 1, bot, cast, emojis, sharedMemories, scenarios };
}

export function loadScenarioFile(filePath: string = DEFAULT_SCENARIOS_PATH): ScenarioFile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new ScenarioFileError(
      `${filePath}: cannot read scenarios (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return parseScenarioFile(raw);
}

/** The scenarios to run: all of them, or the requested ids (an unknown id is an error, not a silent skip). */
export function selectScenarios(file: ScenarioFile, ids: string[]): Scenario[] {
  if (ids.length === 0) return file.scenarios;
  const byId = new Map(file.scenarios.map((s) => [s.id, s]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new ScenarioFileError(`unknown scenario id(s): ${unknown.join(', ')} (known: ${[...byId.keys()].join(', ')})`);
  }
  return ids.map((id) => byId.get(id) as Scenario);
}

export function castMember(file: ScenarioFile, name: string): CastMember | undefined {
  const lower = name.toLowerCase();
  return file.cast.find((c) => c.name.toLowerCase() === lower);
}
