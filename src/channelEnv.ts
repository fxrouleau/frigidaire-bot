// Human-readable channel configuration: every channel id found in the environment, resolved to its
// #name, one line per variable:
//
//   LEARNER_IGNORE_CHANNELS: #mod-logs, #bot-testing (1 unknown: 123456789012345678)
//
// Logged on ClientReady (src/events/channelEnvLog.ts) and included in the deploy announcement, so a
// typo'd or deleted channel id is visible at a glance instead of silently disabling a feature. Variables
// are found by naming convention (config.logging.channelVariables), so new ones appear automatically.
import type { Client } from 'discord.js';
import { config } from './config';
import { logger } from './logger';

const SNOWFLAKE = /^\d{17,20}$/;
const MAX_TOKEN_CHARS = 40;

export type ChannelVariable = {
  name: string;
  /** Snowflake-looking ids, deduplicated, in the order written. */
  ids: string[];
  /** Entries that are not channel ids at all (a typo, a name instead of an id). */
  invalid: string[];
  /** Set when the value could not be read at all (CHANNEL_NOTES that is not a JSON object). */
  problem?: string;
};

/** Finds the channel ids in each variable: csv/whitespace lists, or the keys of CHANNEL_NOTES' JSON object. */
export function parseChannelVariables(vars: Array<{ name: string; value: string }>): ChannelVariable[] {
  return vars.map(({ name, value }) => {
    let tokens: string[];
    if (name === 'CHANNEL_NOTES') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return { name, ids: [], invalid: [], problem: 'not valid JSON' };
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { name, ids: [], invalid: [], problem: 'not a JSON object of channel id → note' };
      }
      tokens = Object.keys(parsed);
    } else {
      tokens = value.split(/[\s,;]+/).filter((token) => token.length > 0);
    }

    const ids: string[] = [];
    const invalid: string[] = [];
    for (const raw of tokens) {
      const token = raw.trim();
      if (SNOWFLAKE.test(token)) {
        if (!ids.includes(token)) ids.push(token);
      } else if (token.length > 0) {
        invalid.push(token.length > MAX_TOKEN_CHARS ? `${token.slice(0, MAX_TOKEN_CHARS)}…` : token);
      }
    }
    return { name, ids, invalid };
  });
}

/** Resolves a channel id to its name; undefined when the bot cannot see it (deleted, wrong id, no access). */
export type ChannelNameLookup = (id: string) => Promise<string | undefined>;

/**
 * Looks channels up through the client. channels.fetch() answers from the cache first (every guild
 * channel is cached at ready), so only ids the bot cannot see cost an API call — and those fail.
 */
export function discordChannelLookup(client: Client): ChannelNameLookup {
  return async (id) => {
    try {
      const channel = await client.channels.fetch(id);
      if (channel && 'name' in channel && typeof channel.name === 'string' && channel.name.length > 0) {
        return channel.name;
      }
      return undefined;
    } catch (error) {
      // Unknown Channel / Missing Access: reported as "unknown" in the output, which is the signal.
      logger.debug(`channelEnv: cannot resolve channel ${id}:`, error);
      return undefined;
    }
  };
}

/** One report line for a variable, given the resolved names (id → name, undefined = unknown). */
export function formatChannelVariable(variable: ChannelVariable, names: Map<string, string | undefined>): string {
  if (variable.problem) return `${variable.name}: (${variable.problem})`;

  const known: string[] = [];
  const unknown: string[] = [];
  for (const id of variable.ids) {
    const name = names.get(id);
    if (name) known.push(`#${name}`);
    else unknown.push(id);
  }

  const parts: string[] = [];
  if (known.length > 0) parts.push(known.join(', '));
  if (unknown.length > 0) parts.push(`(${unknown.length} unknown: ${unknown.join(', ')})`);
  if (variable.invalid.length > 0) {
    parts.push(`(${variable.invalid.length} not a channel id: ${variable.invalid.join(', ')})`);
  }
  if (parts.length === 0) parts.push('(no channel ids)');
  return `${variable.name}: ${parts.join(' ')}`;
}

/** Resolves every channel variable's ids (each distinct id once, in parallel) into report lines. */
export async function describeChannelEnvironment(
  lookup: ChannelNameLookup,
  vars: Array<{ name: string; value: string }> = config.logging.channelVariables,
): Promise<string[]> {
  const variables = parseChannelVariables(vars);
  const distinct = [...new Set(variables.flatMap((v) => v.ids))];
  const resolved = await Promise.all(distinct.map(async (id) => [id, await lookup(id)] as const));
  const names = new Map<string, string | undefined>(resolved);
  return variables.map((v) => formatChannelVariable(v, names));
}
