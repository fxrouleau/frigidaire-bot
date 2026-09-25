import { describe, expect, it } from 'vitest';
import { createPostableChannel, discordError } from '../test-support/fakeScheduling';
import { POLL_LIMITS, buildPoll, postPoll } from './polls';

function error(result: ReturnType<typeof buildPoll>): string {
  if (result.ok) throw new Error('expected a validation error');
  return result.error;
}

describe('buildPoll', () => {
  it('builds discord.js PollData with trimmed text and the defaults', () => {
    expect(buildPoll({ question: '  where we eating? ', answers: [' pho ', 'tacos', ''] })).toEqual({
      ok: true,
      poll: {
        question: { text: 'where we eating?' },
        answers: [{ text: 'pho' }, { text: 'tacos' }],
        duration: 24,
        allowMultiselect: false,
      },
    });
  });

  it('passes duration and multiselect through', () => {
    const result = buildPoll({ question: 'q', answers: ['a'], durationHours: 768, allowMultiselect: true });
    expect(result.ok && result.poll).toMatchObject({ duration: 768, allowMultiselect: true });
    expect(buildPoll({ question: 'q', answers: ['a'], durationHours: '1' }).ok).toBe(true);
  });

  it("enforces Discord's question and answer limits", () => {
    expect(error(buildPoll({ question: '  ', answers: ['a'] }))).toBe('The poll needs a question.');
    expect(error(buildPoll({ question: 'x'.repeat(POLL_LIMITS.questionChars + 1), answers: ['a'] }))).toContain(
      'Discord allows 300',
    );
    expect(buildPoll({ question: 'x'.repeat(POLL_LIMITS.questionChars), answers: ['a'] }).ok).toBe(true);
    expect(error(buildPoll({ question: 'q', answers: [] }))).toBe('The poll needs at least one answer.');
    expect(error(buildPoll({ question: 'q', answers: 'a, b' }))).toContain('list');
    const eleven = Array.from({ length: 11 }, (_, i) => `option ${i}`);
    expect(error(buildPoll({ question: 'q', answers: eleven }))).toContain('at most 10');
    expect(buildPoll({ question: 'q', answers: eleven.slice(0, 10) }).ok).toBe(true);
    const long = 'y'.repeat(POLL_LIMITS.answerChars + 1);
    expect(error(buildPoll({ question: 'q', answers: ['fine', long] }))).toContain(`"${long}" (56)`);
    expect(error(buildPoll({ question: 'q', answers: ['Pho', 'pho'] }))).toContain('listed twice');
  });

  it('only accepts whole hours from 1 to 768', () => {
    for (const bad of [0, 0.5, 769, -3, 'soon', Number.NaN]) {
      expect(error(buildPoll({ question: 'q', answers: ['a'], durationHours: bad }))).toContain('whole number of hours');
    }
  });
});

describe('postPoll', () => {
  const poll = { question: { text: 'q?' }, answers: [{ text: 'a' }, { text: 'b' }], duration: 48, allowMultiselect: true };

  it('sends the poll with mentions disabled and describes it for the model', async () => {
    const target = createPostableChannel();
    const result = await postPoll(target.channel, poll);
    expect(target.sent).toEqual([{ poll, allowedMentions: { parse: [] } }]);
    expect(result).toMatch(/^Poll posted \(message id sent-\d+\): "q\?" with 2 answer\(s\), open for 2 days, multiple choice\./);
  });

  it('explains a missing permission in words the model can relay', async () => {
    const target = createPostableChannel({
      sendImpl: async () => {
        throw discordError(50013, 'Missing Permissions');
      },
    });
    expect(await postPoll(target.channel, poll)).toContain('Create Polls permission');
  });

  it('reports any other Discord error', async () => {
    const target = createPostableChannel({
      sendImpl: async () => {
        throw discordError(50035, 'Invalid Form Body');
      },
    });
    expect(await postPoll(target.channel, poll)).toBe("Couldn't post the poll — Discord said: Invalid Form Body");
  });
});
