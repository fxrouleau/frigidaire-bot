// The LLM judge: scores one reply on the persona rubric. The judge sees what the bot saw (the channel,
// the triggering message, what it had stored about people) plus the scenario's intent, and returns a
// 1-5 score with a one-line reason per dimension.
import type OpenAI from 'openai';
import { featureRequestOptions } from '../../ai/usage';

export const RUBRIC_DIMENSIONS = [
  'brevity',
  'in_character',
  'no_moralizing',
  'answers_message',
  'emoji_discipline',
  'memory_use',
] as const;
export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

export type JudgeScore = { score: number; reason: string };
export type JudgeVerdict = { scores: Record<RubricDimension, JudgeScore>; summary: string };

export type JudgeInput = {
  botName: string;
  scenarioTitle: string;
  /** What a great reply does (the scenario's expectations.notes). */
  intent: string;
  /** The channel as the bot saw it, oldest first, ending with the triggering message. */
  transcript: string;
  /** "Subject: content" lines of everything the bot had stored going into the turn. */
  storedMemories: string[];
  reply: string;
};

export type Judge = (input: JudgeInput) => Promise<JudgeVerdict>;

const RUBRIC: Record<RubricDimension, string> = {
  brevity:
    'Length fits the ask. The group-chat default is 1-3 sentences; longer only when someone explicitly asks for detail or genuine help needs it. 5 = exactly as long as it needs to be; 1 = a wall of text for a casual ping, or a one-liner when detail was requested.',
  in_character:
    'Sounds like a funny, opinionated friend who is part of the group and matches the energy — not an assistant ("Great question!", "Happy to help", "Let me know if..."), never "as an AI". Takes a side when asked; roasts when asked to roast. 1 = generic assistant voice.',
  no_moralizing:
    'No lectures, disclaimers, safety caveats, hedging or "healthier alternatives" on banter, roasts or edgy jokes. Sincere care for someone who is genuinely distressed is NOT moralizing. 5 = none at all; 1 = a lecture.',
  answers_message:
    'Responds to what the current message actually asks: correct and useful for help or info questions, a real roast for a roast request, a real opinion for an opinion. Not hijacked by stale or unrelated history. 1 = misses the point or is wrong.',
  emoji_discipline:
    'Custom server emojis (<:name:id>) and unicode emojis are rare: at most one, only as the punchline or a one-word reaction, never decoration on a normal sentence. No emoji at all = 5 unless the intent says one was clearly called for.',
  memory_use:
    'Uses what it knows about people only when relevant, and naturally (no "I remember that you...", no forced inside jokes, no showing off). Honors corrections. If nothing stored is relevant, mentioning none of it = 5; dragging irrelevant facts in = 1.',
};

const SYSTEM_PROMPT = `You grade replies written by a Discord bot for a private, adults-only server of close friends. The bot is supposed to be "one of the group": a member hanging out in the chat, not an assistant. In this group roasting, crude jokes and dark humor are consensual banter; nobody is offended. The bot should match the energy, keep it short unless asked for detail, never moralize or add disclaimers, rarely use emojis, and drop the bit to help properly when someone genuinely needs help or is actually distressed.

Score the reply on each dimension from 1 (bad) to 5 (excellent):
${RUBRIC_DIMENSIONS.map((d) => `- ${d}: ${RUBRIC[d]}`).join('\n')}

Judge the reply as a message posted in that channel, by the standards above — not by general-purpose assistant standards. Return only JSON:
{"scores": {${RUBRIC_DIMENSIONS.map((d) => `"${d}": {"score": 1-5, "reason": "one short sentence"}`).join(', ')}}, "summary": "one sentence overall"}`;

// Structured output where the judge model supports it; OpenRouter drops the parameter for models that
// don't (it is not a required parameter), and the lenient parser below handles free-form JSON anyway.
const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'persona_grade',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['scores', 'summary'],
      properties: {
        scores: {
          type: 'object',
          additionalProperties: false,
          required: [...RUBRIC_DIMENSIONS],
          properties: Object.fromEntries(
            RUBRIC_DIMENSIONS.map((d) => [
              d,
              {
                type: 'object',
                additionalProperties: false,
                required: ['score', 'reason'],
                properties: { score: { type: 'integer' }, reason: { type: 'string' } },
              },
            ]),
          ),
        },
        summary: { type: 'string' },
      },
    },
  },
} as const;

export function buildJudgeMessages(input: JudgeInput): Array<{ role: 'system' | 'user'; content: string }> {
  const memories =
    input.storedMemories.length > 0 ? input.storedMemories.map((m) => `- ${m}`).join('\n') : '(nothing stored)';
  const user = `Scenario: ${input.scenarioTitle}
What a great reply does here: ${input.intent}

What ${input.botName} had stored about people and the server going into this turn (it may or may not have been shown all of it):
${memories}

The channel (oldest first; the last message is the one that pinged ${input.botName}):
${input.transcript}

${input.botName}'s reply:
<<<
${input.reply}
>>>`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses the judge's JSON (tolerating code fences and prose around it). Undefined unless every dimension scored. */
export function parseJudgeVerdict(text: string): JudgeVerdict | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.scores)) return undefined;

  const scores = {} as Record<RubricDimension, JudgeScore>;
  for (const dimension of RUBRIC_DIMENSIONS) {
    const entry = parsed.scores[dimension];
    // Accept both {"score": 4, "reason": "..."} and a bare number.
    const rawScore = isRecord(entry) ? entry.score : entry;
    const score = typeof rawScore === 'string' ? Number(rawScore) : rawScore;
    if (typeof score !== 'number' || !Number.isFinite(score)) return undefined;
    scores[dimension] = {
      score: Math.min(5, Math.max(1, Math.round(score))),
      reason: isRecord(entry) && typeof entry.reason === 'string' ? entry.reason.trim() : '',
    };
  }
  return { scores, summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '' };
}

export type LlmJudgeOptions = {
  client: OpenAI;
  model: string;
  /** Attempts before giving up on unparseable output (default 2). */
  attempts?: number;
};

/** A judge backed by a chat model over OpenRouter (ZDR, tagged 'eval'). Throws when no verdict could be parsed. */
export function createLlmJudge(opts: LlmJudgeOptions): Judge {
  const attempts = Math.max(1, opts.attempts ?? 2);
  return async (input) => {
    let lastText = '';
    for (let attempt = 0; attempt < attempts; attempt++) {
      const response = await opts.client.chat.completions.create(
        {
          model: opts.model,
          temperature: 0,
          messages: buildJudgeMessages(input),
          // @ts-expect-error OpenRouter-specific fields: ZDR routing is mandatory for anything carrying chat text
          provider: { zdr: true },
          response_format: RESPONSE_FORMAT,
        },
        featureRequestOptions('eval'),
      );
      lastText = response.choices?.[0]?.message?.content ?? '';
      const verdict = parseJudgeVerdict(lastText);
      if (verdict) return verdict;
    }
    throw new Error(`judge ${opts.model} returned no parseable verdict: ${lastText.slice(0, 200)}`);
  };
}

/** The mean of the rubric scores (1-5). */
export function overallScore(verdict: JudgeVerdict): number {
  const total = RUBRIC_DIMENSIONS.reduce((sum, d) => sum + verdict.scores[d].score, 0);
  return total / RUBRIC_DIMENSIONS.length;
}
