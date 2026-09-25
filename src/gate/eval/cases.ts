// The gate's eval set: labelled "is this message addressed to the bot?" cases. `yarn eval:gate` runs them
// live against the decision model (runEval.ts); cases.test.ts validates the bundled file offline.
//
// Two sources: the synthetic cases in src/gate/eval/cases.json (committed; invented people and chat) and
// the owner's optional data/gate-cases.json (gitignored; built from real Discord logs, same format).
//
// File format:
//   {
//     "version": 1,
//     "cases": [
//       {
//         "id": "name-question-worlds",        // unique across every file
//         "label": true,                       // true = addressed to the bot, it should answer
//         "note": "why this label",            // optional
//         "context": [                         // the messages right before `message`, oldest first
//           { "author": "Kev", "text": "worlds draw is out" },
//           { "author": "Frigidaire", "bot": true, "text": "T1 again lol", "replyTo": "Kev" },
//           { "author": "Hermes", "otherBot": true, "text": "daily recap: ..." }
//         ],
//         "message": { "author": "Marco", "text": "fridge who wins worlds", "replyTo": "Theo" },
//         "botLastSpokeSecondsAgo": 30,        // optional; omitted/null = the bot hasn't spoken recently
//         "talkingWithBot": true               // optional, default false: the author is who the bot last answered
//       }
//     ]
//   }
//
// `bot: true` marks the bot's own messages, `otherBot: true` another bot's; `replyTo` is whose message a
// Discord reply points at. A case is only relevant to the live gate when it passes the prefilter (its
// text names the bot, or it is a follow-up); the runner reports both views.
import * as fs from 'node:fs';
import type { AddressedInput, ChatLine } from '../addressed';
import { createNameMatcher, isFollowup } from '../text';

export const EVAL_BOT_NAME = 'Frigidaire';

export type GateEvalLine = { author: string; text: string; bot?: boolean; otherBot?: boolean; replyTo?: string };

export type GateEvalCase = {
  id: string;
  label: boolean;
  note?: string;
  context: GateEvalLine[];
  message: { author: string; text: string; replyTo?: string };
  botLastSpokeSecondsAgo?: number | null;
  talkingWithBot?: boolean;
};

const CASE_KEYS = new Set(['id', 'label', 'note', 'context', 'message', 'botLastSpokeSecondsAgo', 'talkingWithBot']);
const LINE_KEYS = new Set(['author', 'text', 'bot', 'otherBot', 'replyTo']);
const MESSAGE_KEYS = new Set(['author', 'text', 'replyTo']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function validateLine(line: unknown, where: string, keys: Set<string>, errors: string[]): void {
  if (!isRecord(line)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  const extra = unknownKeys(line, keys);
  if (extra.length > 0) errors.push(`${where}: unknown field(s) ${extra.join(', ')}`);
  if (!nonEmptyString(line.author)) errors.push(`${where}.author: must be a non-empty string`);
  if (!nonEmptyString(line.text)) errors.push(`${where}.text: must be a non-empty string`);
  if (line.replyTo !== undefined && !nonEmptyString(line.replyTo)) errors.push(`${where}.replyTo: must be a string`);
  for (const flag of ['bot', 'otherBot'] as const) {
    if (line[flag] !== undefined && typeof line[flag] !== 'boolean') errors.push(`${where}.${flag}: must be a boolean`);
  }
  if (line.bot === true && line.otherBot === true) errors.push(`${where}: cannot be both bot and otherBot`);
}

/** Validates a parsed case file. Unknown fields are errors, so a typo can't silently change a case. */
export function validateCaseFile(raw: unknown, source: string): { cases: GateEvalCase[]; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { cases: [], errors: [`${source}: the file must be a JSON object`] };
  if (raw.version !== 1) errors.push(`${source}: "version" must be 1`);
  if (!Array.isArray(raw.cases)) return { cases: [], errors: [...errors, `${source}: "cases" must be an array`] };

  const seen = new Set<string>();
  raw.cases.forEach((entry: unknown, index: number) => {
    const where = `${source} cases[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    const extra = unknownKeys(entry, CASE_KEYS);
    if (extra.length > 0) errors.push(`${where}: unknown field(s) ${extra.join(', ')}`);
    if (!nonEmptyString(entry.id)) {
      errors.push(`${where}.id: must be a non-empty string`);
    } else if (seen.has(entry.id)) {
      errors.push(`${where}.id: duplicate id "${entry.id}"`);
    } else {
      seen.add(entry.id);
    }
    if (typeof entry.label !== 'boolean') errors.push(`${where}.label: must be true or false`);
    if (entry.note !== undefined && typeof entry.note !== 'string') errors.push(`${where}.note: must be a string`);
    if (!Array.isArray(entry.context)) {
      errors.push(`${where}.context: must be an array (use [] for none)`);
    } else {
      entry.context.forEach((line: unknown, i: number) => validateLine(line, `${where}.context[${i}]`, LINE_KEYS, errors));
    }
    validateLine(entry.message, `${where}.message`, MESSAGE_KEYS, errors);
    const seconds = entry.botLastSpokeSecondsAgo;
    if (seconds !== undefined && seconds !== null && !(typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0)) {
      errors.push(`${where}.botLastSpokeSecondsAgo: must be a number >= 0, or null`);
    }
    if (entry.talkingWithBot !== undefined && typeof entry.talkingWithBot !== 'boolean') {
      errors.push(`${where}.talkingWithBot: must be a boolean`);
    }
  });

  return { cases: errors.length === 0 ? (raw.cases as GateEvalCase[]) : [], errors };
}

/** Reads and validates a case file; throws with every problem listed. */
export function loadCaseFile(filePath: string): GateEvalCase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${filePath}: not readable JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const { cases, errors } = validateCaseFile(parsed, filePath);
  if (errors.length > 0) throw new Error(`${filePath} is invalid:\n  ${errors.join('\n  ')}`);
  return cases;
}

/** The decision-model input for a case: exactly what the live gate would build for that chat. */
export function caseToInput(c: GateEvalCase, nicknames: string[], botName = EVAL_BOT_NAME): AddressedInput {
  const context: ChatLine[] = c.context.map((line) => ({
    author: line.author,
    text: line.text,
    ...(line.bot ? { kind: 'self' as const } : line.otherBot ? { kind: 'other_bot' as const } : {}),
    ...(line.replyTo ? { replyTo: line.replyTo } : {}),
  }));
  return {
    botName,
    nicknames,
    message: { ...c.message },
    context,
    secondsSinceBotSpoke: c.botLastSpokeSecondsAgo ?? undefined,
    authorIsBotsPartner: c.talkingWithBot ?? false,
  };
}

/** Whether the live gate's free prefilter would let this case through to the decision model. */
export function passesPrefilter(
  c: GateEvalCase,
  names: string[],
  followupSeconds: number,
  botName = EVAL_BOT_NAME,
): boolean {
  const nameHit = createNameMatcher([...names, botName])(c.message.text) !== undefined;
  return nameHit || isFollowup(c.botLastSpokeSecondsAgo ?? undefined, c.talkingWithBot ?? false, followupSeconds);
}
