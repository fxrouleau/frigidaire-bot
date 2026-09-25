import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeCommandDeps,
  createFakeGuild,
  createFakeMessageCommandInteraction,
  createFakeTargetMessage,
} from '../test-support/fakeInteraction';
import { ASK_FRIDGE_LINES } from './askFridge';
import { handleContextMenuCommand } from './index';
import { LINES } from './respond';

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const warned = () => log.mock.calls.some((c: unknown[]) => String(c[0]).includes('[WARN]'));

describe('Ask Fridge', () => {
  it('acknowledges privately right away and runs the agent on the target without waiting for it', async () => {
    const { guild, recorders: guildRecorders } = createFakeGuild({ members: { 'user-7': 'Jason' } });
    const target = createFakeTargetMessage({ authorId: 'user-7', content: 'is a hotdog a sandwich', guild });
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Ask Fridge' });

    let finishAgent = () => {};
    const agentDone = new Promise<void>((resolve) => {
      finishAgent = resolve;
    });
    const { deps, recorders } = createFakeCommandDeps({ askAgent: () => agentDone });

    await handleContextMenuCommand(interaction, deps);

    // The interaction is answered even though the agent hasn't finished.
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ method: 'reply', content: ASK_FRIDGE_LINES.onIt, ephemeral: true });

    await vi.waitFor(() => expect(recorders.askAgent.calls).toHaveLength(1));
    expect(recorders.askAgent.calls[0][0]).toBe(target.message);
    // The author's member was fetched so the agent can label the speaker.
    expect(guildRecorders.membersFetch.calls).toEqual([['user-7']]);

    finishAgent();
    await agentDone;
    expect(responses).toHaveLength(1);
  });

  it('does not answer the same message twice while the first answer is still being written', async () => {
    const target = createFakeTargetMessage({ messageId: 'msg-dup', content: 'thoughts?' });
    let finishAgent = () => {};
    const agentDone = new Promise<void>((resolve) => {
      finishAgent = resolve;
    });
    const { deps, recorders } = createFakeCommandDeps({ askAgent: () => agentDone });

    const first = createFakeMessageCommandInteraction(target.message, { commandName: 'Ask Fridge', invokerId: 'a' });
    await handleContextMenuCommand(first.interaction, deps);
    await vi.waitFor(() => expect(recorders.askAgent.calls).toHaveLength(1));

    // The first run() has returned (the invoker got "on it"), but the agent is still going.
    const second = createFakeMessageCommandInteraction(target.message, { commandName: 'Ask Fridge', invokerId: 'b' });
    await handleContextMenuCommand(second.interaction, deps);
    expect(second.responses).toEqual([
      expect.objectContaining({ method: 'reply', content: ASK_FRIDGE_LINES.alreadyAnswering, ephemeral: true }),
    ]);

    finishAgent();
    await vi.waitFor(async () => {
      const third = createFakeMessageCommandInteraction(target.message, { commandName: 'Ask Fridge' });
      await handleContextMenuCommand(third.interaction, deps);
      expect(third.texts()).toEqual([ASK_FRIDGE_LINES.onIt]);
    });
    await vi.waitFor(() => expect(recorders.askAgent.calls).toHaveLength(2));
  });

  it('does not run the agent, and frees the message again, when the acknowledgement fails', async () => {
    const target = createFakeTargetMessage({ messageId: 'msg-expired' });
    const { deps, recorders } = createFakeCommandDeps();
    const expired = createFakeMessageCommandInteraction(target.message, {
      commandName: 'Ask Fridge',
      failOn: { reply: new Error('Unknown interaction') },
    });
    await expect(handleContextMenuCommand(expired.interaction, deps)).resolves.toBeUndefined();
    expect(recorders.askAgent.calls).toHaveLength(0);

    const retry = createFakeMessageCommandInteraction(target.message, { commandName: 'Ask Fridge' });
    await handleContextMenuCommand(retry.interaction, deps);
    await vi.waitFor(() => expect(recorders.askAgent.calls).toHaveLength(1));
  });

  it("refuses the bot's own messages", async () => {
    const target = createFakeTargetMessage({ authorId: 'bot-1', authorIsBot: true });
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Ask Fridge' });
    const { deps, recorders } = createFakeCommandDeps();

    await handleContextMenuCommand(interaction, deps);

    expect(responses).toEqual([expect.objectContaining({ method: 'reply', content: ASK_FRIDGE_LINES.ownMessage, ephemeral: true })]);
    expect(recorders.askAgent.calls).toHaveLength(0);
  });

  it('answers messages from other bots and webhooks without a member lookup', async () => {
    const { guild, recorders: guildRecorders } = createFakeGuild();
    const target = createFakeTargetMessage({ webhookId: 'hook-1', authorId: 'hook-1', guild });
    const { interaction } = createFakeMessageCommandInteraction(target.message, { commandName: 'Ask Fridge' });
    const { deps, recorders } = createFakeCommandDeps();

    await handleContextMenuCommand(interaction, deps);

    await vi.waitFor(() => expect(recorders.askAgent.calls).toHaveLength(1));
    expect(guildRecorders.membersFetch.calls).toHaveLength(0);
  });

  it('tells the invoker privately when the agent blows up, and logs a WARN', async () => {
    const target = createFakeTargetMessage();
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Ask Fridge' });
    const { deps } = createFakeCommandDeps({
      askAgent: async () => {
        throw new Error('agent exploded');
      },
    });

    await handleContextMenuCommand(interaction, deps);

    await vi.waitFor(() => expect(responses).toHaveLength(2));
    expect(responses[1]).toMatchObject({ method: 'editReply', content: LINES.failed, ephemeral: true });
    expect(warned()).toBe(true);
  });

  it("says so when the target's channel can't be reached", async () => {
    const target = createFakeTargetMessage({ channelUncached: true, channelFetchFails: true });
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Ask Fridge' });
    const { deps, recorders } = createFakeCommandDeps();

    await handleContextMenuCommand(interaction, deps);

    await vi.waitFor(() => expect(responses).toHaveLength(2));
    expect(responses[1]).toMatchObject({ method: 'editReply', content: LINES.noChannel });
    expect(recorders.askAgent.calls).toHaveLength(0);
  });
});
