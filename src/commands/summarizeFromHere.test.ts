import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_NOW,
  createFakeCommandDeps,
  createFakeMessageCommandInteraction,
  createFakeTargetMessage,
} from '../test-support/fakeInteraction';
import { handleContextMenuCommand } from './index';
import { LINES } from './respond';
import { MAX_SUMMARY_RANGE_MS } from './summarizeFromHere';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const HOUR = 60 * 60 * 1000;

describe('Summarize from here', () => {
  it('asks as the main account when invoked from a linked side account (LINKED_ACCOUNTS)', async () => {
    vi.stubEnv('LINKED_ACCOUNTS', '100000000000000002:100000000000000001');
    try {
      const target = createFakeTargetMessage({ createdAt: new Date(FAKE_NOW.getTime() - HOUR) });
      const { interaction } = createFakeMessageCommandInteraction(target.message, {
        commandName: 'Summarize from here',
        invokerId: '100000000000000002',
      });
      const { deps, recorders } = createFakeCommandDeps({ summarize: async () => ({ ok: true, text: 'stuff' }) });

      await handleContextMenuCommand(interaction, deps);

      expect(recorders.summarize.calls[0][0].requesterId).toBe('100000000000000001');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('summarizes from the target to now and posts it publicly as a reply to the target', async () => {
    const createdAt = new Date(FAKE_NOW.getTime() - 3 * HOUR);
    const target = createFakeTargetMessage({ createdAt });
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, {
      commandName: 'Summarize from here',
      invokerId: 'user-5',
      invokerDisplayName: 'Remi',
    });
    const { deps, recorders } = createFakeCommandDeps({
      summarize: async () => ({ ok: true, text: 'Jasper lost at League again. <@123>' }),
    });

    await handleContextMenuCommand(interaction, deps);

    expect(recorders.summarize.calls).toHaveLength(1);
    const request = recorders.summarize.calls[0][0];
    expect(request.message).toBe(target.message);
    expect(request.start).toEqual(createdAt);
    expect(request.end).toEqual(FAKE_NOW);
    expect(request.requesterId).toBe('user-5');

    expect(target.recorders.reply.calls).toHaveLength(1);
    const posted = target.recorders.reply.calls[0][0] as { content: string; allowedMentions: unknown };
    expect(posted.content).toBe('-# summary from here to now · asked by Remi\nJasper lost at League again. <@123>');
    expect(posted.allowedMentions).toEqual({ parse: [], repliedUser: false });

    // The invoker's side stayed private the whole time.
    expect(responses.map((r) => [r.method, r.ephemeral])).toEqual([
      ['deferReply', true],
      ['editReply', true],
    ]);
    expect(responses[1].content).toMatch(/^posted it: https:\/\/discord\.com\/channels\//);
  });

  it('caps the range at 7 days and says so', async () => {
    const target = createFakeTargetMessage({ createdAt: new Date(FAKE_NOW.getTime() - 30 * 24 * HOUR) });
    const { interaction } = createFakeMessageCommandInteraction(target.message, { commandName: 'Summarize from here' });
    const { deps, recorders } = createFakeCommandDeps();

    await handleContextMenuCommand(interaction, deps);

    const request = recorders.summarize.calls[0][0];
    expect(request.end.getTime() - request.start.getTime()).toBe(MAX_SUMMARY_RANGE_MS);
    const posted = target.recorders.reply.calls[0][0] as { content: string };
    expect(posted.content).toMatch(/^-# summary of the last 7 days \(that message is older than a week\)/);
  });

  it('keeps a failed summary private and posts nothing', async () => {
    const target = createFakeTargetMessage({ createdAt: new Date(FAKE_NOW.getTime() - HOUR) });
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Summarize from here' });
    const { deps } = createFakeCommandDeps({ summarize: async () => ({ ok: false, reason: 'nothing to summarize from there' }) });

    await handleContextMenuCommand(interaction, deps);

    expect(target.recorders.reply.calls).toHaveLength(0);
    expect(target.recorders.send.calls).toHaveLength(0);
    expect(responses.at(-1)).toMatchObject({ method: 'editReply', content: 'nothing to summarize from there', ephemeral: true });
  });

  it('turns a crashing summary pipeline into the in-character failure', async () => {
    const target = createFakeTargetMessage({ createdAt: new Date(FAKE_NOW.getTime() - HOUR) });
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Summarize from here' });
    const { deps } = createFakeCommandDeps({
      summarize: async () => {
        throw new Error('OPENROUTER_API_KEY is required for chat.');
      },
    });

    await handleContextMenuCommand(interaction, deps);

    expect(responses.at(-1)).toMatchObject({ method: 'editReply', content: LINES.failed, ephemeral: true });
    expect(target.recorders.reply.calls).toHaveLength(0);
  });

  it('reports privately when the bot may not post in the channel', async () => {
    const missing = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    const target = createFakeTargetMessage({
      createdAt: new Date(FAKE_NOW.getTime() - HOUR),
      replyImpl: async () => {
        throw missing;
      },
      sendImpl: async () => {
        throw missing;
      },
    });
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Summarize from here' });
    const { deps } = createFakeCommandDeps();

    await handleContextMenuCommand(interaction, deps);

    expect(responses.at(-1)).toMatchObject({ method: 'editReply', content: LINES.cannotPost });
  });
});
