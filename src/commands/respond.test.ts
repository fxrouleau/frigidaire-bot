import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeMessageCommandInteraction, createFakeTargetMessage } from '../test-support/fakeInteraction';
import {
  DISCORD_MESSAGE_LIMIT,
  LINES,
  answerPrivately,
  blockQuote,
  chunksFor,
  discordErrorCode,
  failPrivately,
  postPublicReply,
  subtext,
} from './respond';
import { CommandError } from './types';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function interactionFor(opts: Parameters<typeof createFakeMessageCommandInteraction>[1] = { commandName: 'Test' }) {
  return createFakeMessageCommandInteraction(createFakeTargetMessage().message, opts);
}

describe('chunksFor', () => {
  it('keeps short text in one chunk', () => {
    expect(chunksFor('hello', 3)).toEqual(['hello']);
  });

  it('caps the number of chunks and marks the cut within the message limit', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(80)}`).join('\n');
    const chunks = chunksFor(text, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toMatch(/cut off, too long to post$/);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
  });

  it('never produces an empty message', () => {
    expect(chunksFor('', 2)).toEqual(['(empty)']);
  });
});

describe('blockQuote', () => {
  it('quotes every line, keeping blank lines inside the quote', () => {
    expect(blockQuote('one\n\ntwo')).toBe('> one\n>\n> two');
  });

  it('wraps a giant paragraph at word boundaries so no quoted line exceeds the limit', () => {
    const paragraph = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ');
    const quoted = blockQuote(paragraph, 500);
    const lines = quoted.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith('> ')).toBe(true);
      expect(line.length).toBeLessThanOrEqual(502);
    }
    // No word was cut in half: rejoining the wrapped lines gives back the paragraph.
    expect(lines.map((l) => l.slice(2)).join(' ')).toBe(paragraph);
  });

  it('hard-cuts a line with no spaces', () => {
    const quoted = blockQuote('y'.repeat(1200), 500);
    expect(quoted.split('\n').map((l) => l.length)).toEqual([502, 502, 202]);
  });
});

describe('subtext / discordErrorCode', () => {
  it('formats subtext', () => {
    expect(subtext('hi')).toBe('-# hi');
  });

  it('reads numeric Discord error codes only', () => {
    expect(discordErrorCode(Object.assign(new Error('x'), { code: 50013 }))).toBe(50013);
    expect(discordErrorCode(Object.assign(new Error('x'), { code: 'InteractionNotReplied' }))).toBeUndefined();
    expect(discordErrorCode('nope')).toBeUndefined();
  });
});

describe('answerPrivately', () => {
  it('replies ephemerally to a fresh interaction, without pings', async () => {
    const { interaction, responses } = interactionFor();
    await answerPrivately(interaction, 'hey <@123>');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ method: 'reply', content: 'hey <@123>', ephemeral: true });
    expect(responses[0].options).toMatchObject({ allowedMentions: { parse: [] } });
  });

  it('edits the deferred response, then continues long text in ephemeral follow-ups', async () => {
    const { interaction, responses } = interactionFor();
    await interaction.deferReply({ flags: 64 });
    const long = Array.from({ length: 60 }, (_, i) => `line ${i} ${'z'.repeat(60)}`).join('\n');
    await answerPrivately(interaction, long);
    expect(responses.map((r) => r.method)).toEqual(['deferReply', 'editReply', 'followUp', 'followUp']);
    expect(responses.every((r) => r.ephemeral)).toBe(true);
  });
});

describe('failPrivately', () => {
  it('swallows a failing response (expired token) and logs it', async () => {
    const warn = vi.spyOn(console, 'log');
    const { interaction } = interactionFor({ commandName: 'Test', failOn: { reply: new Error('Unknown interaction') } });
    await expect(failPrivately(interaction, LINES.failed)).resolves.toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[WARN]'))).toBe(true);
  });
});

describe('postPublicReply', () => {
  it('replies to the target without pinging anyone and returns the posted message', async () => {
    const { message, recorders } = createFakeTargetMessage();
    const posted = await postPublicReply(message, 'summary <@1> @everyone');
    expect(posted.url).toMatch(/^https:\/\/discord\.com\/channels\//);
    expect(recorders.reply.calls).toHaveLength(1);
    expect(recorders.reply.calls[0][0]).toEqual({
      content: 'summary <@1> @everyone',
      allowedMentions: { parse: [], repliedUser: false },
    });
  });

  it('continues long text as plain channel messages', async () => {
    const { message, recorders } = createFakeTargetMessage();
    const long = Array.from({ length: 60 }, (_, i) => `line ${i} ${'q'.repeat(60)}`).join('\n');
    await postPublicReply(message, long);
    expect(recorders.reply.calls).toHaveLength(1);
    expect(recorders.send.calls.length).toBeGreaterThan(0);
    expect(recorders.send.calls[0][0]).toMatchObject({ allowedMentions: { parse: [] } });
  });

  it('falls back to a plain post when the reply is refused', async () => {
    const { message, recorders } = createFakeTargetMessage({
      replyImpl: async () => {
        throw Object.assign(new Error('Invalid Form Body'), { code: 50035 });
      },
    });
    const posted = await postPublicReply(message, 'hello');
    expect(recorders.send.calls).toHaveLength(1);
    expect(posted.id).toMatch(/^posted-/);
  });

  it('turns a missing permission into a CommandError the invoker can read', async () => {
    const missing = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    const { message } = createFakeTargetMessage({
      replyImpl: async () => {
        throw missing;
      },
      sendImpl: async () => {
        throw missing;
      },
    });
    const error = await postPublicReply(message, 'hello').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).userMessage).toBe(LINES.cannotPost);
  });

  it('rethrows other send failures', async () => {
    const boom = new Error('socket hang up');
    const { message } = createFakeTargetMessage({
      replyImpl: async () => {
        throw boom;
      },
      sendImpl: async () => {
        throw boom;
      },
    });
    await expect(postPublicReply(message, 'hello')).rejects.toBe(boom);
  });
});
