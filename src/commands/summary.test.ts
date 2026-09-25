import type { Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { AiProvider } from '../ai/types';
import { createRecorder } from '../test-support/recorder';
import { LINES } from './respond';
import { summarizeFromMessage } from './summary';

const message = { id: 'm-1' } as unknown as Message;
const start = new Date('2026-09-24T12:00:00.000Z');
const end = new Date('2026-09-25T12:00:00.000Z');

function providerSaying(text: string) {
  const summarizeMessages = createRecorder<[Message, string, string], Promise<string>>(async () => text);
  const provider: AiProvider = {
    id: 'fake',
    defaultModel: 'fake-model',
    supportedTools: [],
    chat: async () => ({ toolCalls: [], outputEntries: [] }),
    summarizeMessages,
  };
  return { provider, summarizeMessages };
}

describe('summarizeFromMessage (legacy provider adapter)', () => {
  it('passes the range as ISO strings and returns the summary', async () => {
    const { provider, summarizeMessages } = providerSaying('  they planned a BBQ  ');
    const result = await summarizeFromMessage({ message, start, end }, provider);
    expect(result).toEqual({ ok: true, text: 'they planned a BBQ' });
    expect(summarizeMessages.calls).toEqual([[message, '2026-09-24T12:00:00.000Z', '2026-09-25T12:00:00.000Z']]);
  });

  it('never posts the legacy failure strings as a summary', async () => {
    const empty = await summarizeFromMessage(
      { message, start, end },
      providerSaying('I found no messages in that time range to summarize.').provider,
    );
    expect(empty).toEqual({ ok: false, reason: 'nothing to summarize from there' });

    const broken = await summarizeFromMessage(
      { message, start, end },
      providerSaying('An error occurred while trying to summarize the messages.').provider,
    );
    expect(broken).toEqual({ ok: false, reason: LINES.failed });

    const blank = await summarizeFromMessage({ message, start, end }, providerSaying('  ').provider);
    expect(blank).toEqual({ ok: false, reason: LINES.failed });
  });

  it('fails cleanly when the provider cannot summarize', async () => {
    const provider: AiProvider = {
      id: 'fake',
      defaultModel: 'm',
      supportedTools: [],
      chat: async () => ({ toolCalls: [], outputEntries: [] }),
    };
    expect(await summarizeFromMessage({ message, start, end }, provider)).toEqual({ ok: false, reason: LINES.failed });
  });
});
