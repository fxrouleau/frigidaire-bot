// Native Discord polls. Limits are Discord's (docs.discord.com/developers/resources/poll, mirrored by
// @discordjs/builders' poll assertions): 1–10 answers, question ≤300 chars, answers ≤55 chars, duration
// in whole hours from 1 to 768 (32 days, default 24). A poll can't be edited after it's posted, so every
// limit is checked here with an error the model can act on instead of a raw 400 from Discord.
import { type PollData, RESTJSONErrorCodes } from 'discord.js';
import { logger } from '../logger';
import { describeError, discordErrorCode, type PostableChannel } from './discord';

export const POLL_LIMITS = {
  questionChars: 300,
  answerChars: 55,
  minAnswers: 1,
  maxAnswers: 10,
  minHours: 1,
  maxHours: 768,
  defaultHours: 24,
} as const;

export type PollRequest = {
  question: unknown;
  answers: unknown;
  durationHours?: unknown;
  allowMultiselect?: unknown;
};

export type PollValidation = { ok: true; poll: PollData } | { ok: false; error: string };

function toNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw.trim());
  return undefined;
}

/** Validates the model's arguments and builds discord.js PollData. */
export function buildPoll(request: PollRequest): PollValidation {
  const question = typeof request.question === 'string' ? request.question.trim() : '';
  if (!question) return { ok: false, error: 'The poll needs a question.' };
  if (question.length > POLL_LIMITS.questionChars) {
    return {
      ok: false,
      error: `The question is ${question.length} characters; Discord allows ${POLL_LIMITS.questionChars}. Shorten it.`,
    };
  }

  if (!Array.isArray(request.answers)) return { ok: false, error: 'answers must be a list of answer texts.' };
  const answers = request.answers.map((a) => (typeof a === 'string' ? a.trim() : '')).filter((a) => a.length > 0);
  if (answers.length < POLL_LIMITS.minAnswers) return { ok: false, error: 'The poll needs at least one answer.' };
  if (answers.length > POLL_LIMITS.maxAnswers) {
    return {
      ok: false,
      error: `That's ${answers.length} answers; Discord allows at most ${POLL_LIMITS.maxAnswers}. Merge or drop some.`,
    };
  }
  const tooLong = answers.filter((a) => a.length > POLL_LIMITS.answerChars);
  if (tooLong.length > 0) {
    return {
      ok: false,
      error: `Each answer can be at most ${POLL_LIMITS.answerChars} characters; too long: ${tooLong.map((a) => `"${a}" (${a.length})`).join(', ')}.`,
    };
  }
  const seen = new Set<string>();
  for (const answer of answers) {
    const key = answer.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `"${answer}" is listed twice — every answer must be different.` };
    seen.add(key);
  }

  let duration: number = POLL_LIMITS.defaultHours;
  if (request.durationHours !== undefined && request.durationHours !== null) {
    const hours = toNumber(request.durationHours);
    if (
      hours === undefined ||
      !Number.isInteger(hours) ||
      hours < POLL_LIMITS.minHours ||
      hours > POLL_LIMITS.maxHours
    ) {
      return {
        ok: false,
        error: `duration_hours must be a whole number of hours from ${POLL_LIMITS.minHours} to ${POLL_LIMITS.maxHours} (32 days); got ${String(request.durationHours)}.`,
      };
    }
    duration = hours;
  }

  const allowMultiselect = request.allowMultiselect === true || request.allowMultiselect === 'true';

  return {
    ok: true,
    poll: {
      question: { text: question },
      answers: answers.map((text) => ({ text })),
      duration,
      allowMultiselect,
    },
  };
}

/** Posts the poll; returns the tool result for the model (never throws). */
export async function postPoll(channel: PostableChannel, poll: PollData): Promise<string> {
  try {
    const message = await channel.send({ poll, allowedMentions: { parse: [] } });
    const hours = poll.duration;
    const length = hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours}h`;
    return `Poll posted (message id ${message.id}): "${poll.question.text}" with ${poll.answers.length} answer(s), open for ${length}${poll.allowMultiselect ? ', multiple choice' : ''}. It's already in the channel — don't repeat the options in your reply.`;
  } catch (error) {
    logger.warn(`polls: posting a poll in ${channel.id} failed:`, error);
    const code = discordErrorCode(error);
    if (code === RESTJSONErrorCodes.MissingPermissions || code === RESTJSONErrorCodes.MissingAccess) {
      return "Couldn't post the poll: I'm missing the Create Polls permission in this channel. Tell them to ask an admin.";
    }
    return `Couldn't post the poll — Discord said: ${describeError(error)}`;
  }
}
