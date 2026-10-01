import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { createFakeButtonInteraction } from '../test-support/fakeInteraction';
import { type ApprovalPayload, claimApproval, createApproval } from './approvalStore';
import { APPROVAL_LINES, type ApprovalDeps, type ApprovalResult, handleApprovalClick } from './handler';
import { approvalCustomId } from './offer';

const OWNER = '400000000000000009';
const NOW = 1_000_000_000;
const LINE = "-# auto-react (shadow) · would react 😂 to Wheelie's post https://discord.com/channels/1/2/3";
const REACTION: ApprovalPayload = {
  kind: 'auto_react',
  channelId: 'channel-1',
  messageId: 'message-1',
  emoji: '😂',
  label: '😂',
};

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  vi.useRealTimers();
  setBotDbForTesting(undefined);
});

function deps(result: ApprovalResult | (() => Promise<ApprovalResult>), owner: boolean | 'never' = true) {
  const execute = vi.fn<ApprovalDeps['execute']>(async () => (typeof result === 'function' ? result() : result));
  const isOwner = vi.fn<ApprovalDeps['isOwner']>(() =>
    owner === 'never' ? new Promise<boolean>(() => {}) : Promise.resolve(owner),
  );
  return { execute, isOwner, now: () => NOW };
}

function click(id: number | string, invokerId = OWNER) {
  return createFakeButtonInteraction({
    customId: typeof id === 'number' ? approvalCustomId(id) : id,
    invokerId,
    messageEphemeral: false,
    messageContent: LINE,
  });
}

describe('handleApprovalClick', () => {
  it('acts on the owner’s click, then marks the line and drops its button', async () => {
    const id = createApproval(REACTION, NOW, NOW + 60_000);
    const d = deps({ status: 'done', note: 'reacted 😂' });
    const fake = click(id);

    await handleApprovalClick(fake.interaction, d);

    expect(d.execute).toHaveBeenCalledWith(REACTION, fake.interaction.client);
    expect(fake.responses.map((r) => r.method)).toEqual(['deferUpdate', 'editReply']);
    const edit = fake.responses[1];
    expect(edit.content).toBe(`${LINE}\n-# ✅ reacted 😂 · approved by <@${OWNER}>`);
    expect(edit.options).toMatchObject({ components: [], allowedMentions: { parse: [] } });
    expect(claimApproval(id, NOW).status).toBe('done');
  });

  it('never acts twice: a second click is told it was already done', async () => {
    const id = createApproval(REACTION, NOW, NOW + 60_000);
    const d = deps({ status: 'done', note: 'reacted 😂' });
    await handleApprovalClick(click(id).interaction, d);

    const again = click(id);
    await handleApprovalClick(again.interaction, d);
    expect(d.execute).toHaveBeenCalledTimes(1);
    expect(again.responses.map((r) => r.method)).toEqual(['update', 'followUp']);
    expect(again.responses[1]).toMatchObject({ content: APPROVAL_LINES.alreadyDone, ephemeral: true });
  });

  it('refuses anyone but the owner, privately, and leaves the offer open', async () => {
    const id = createApproval(REACTION, NOW, NOW + 60_000);
    const d = deps({ status: 'done', note: 'x' }, false);
    const fake = click(id, '400000000000000001');

    await handleApprovalClick(fake.interaction, d);
    expect(d.execute).not.toHaveBeenCalled();
    expect(fake.responses).toEqual([expect.objectContaining({ content: APPROVAL_LINES.notOwner, ephemeral: true })]);
    expect(claimApproval(id, NOW).status).toBe('claimed');
  });

  it('fails closed when the owner check is too slow', async () => {
    vi.useFakeTimers();
    const id = createApproval(REACTION, NOW, NOW + 60_000);
    const d = deps({ status: 'done', note: 'x' }, 'never');
    const fake = click(id);

    const handled = handleApprovalClick(fake.interaction, d);
    await vi.advanceTimersByTimeAsync(2000);
    await handled;
    expect(d.execute).not.toHaveBeenCalled();
    expect(fake.texts()).toEqual([APPROVAL_LINES.ownerUnknown]);
  });

  it('keeps the button when a later click may work, and tells the owner why', async () => {
    const id = createApproval(REACTION, NOW, NOW + 60_000);
    const d = deps({ status: 'retry', note: "couldn't react just now" });
    const fake = click(id);

    await handleApprovalClick(fake.interaction, d);
    expect(fake.responses.map((r) => r.method)).toEqual(['deferUpdate', 'followUp']);
    expect(fake.responses[1]).toMatchObject({ content: "couldn't react just now", ephemeral: true });
    expect(claimApproval(id, NOW).status).toBe('claimed');
  });

  it('treats a throwing action as a retry', async () => {
    const id = createApproval(REACTION, NOW, NOW + 60_000);
    const d = deps(async () => {
      throw new Error('boom');
    });
    const fake = click(id);

    await handleApprovalClick(fake.interaction, d);
    expect(fake.texts()).toEqual([APPROVAL_LINES.failed]);
    expect(claimApproval(id, NOW).status).toBe('claimed');
  });

  it('closes an offer that can never happen, with the reason on the line', async () => {
    const id = createApproval(REACTION, NOW, NOW + 60_000);
    const fake = click(id);

    await handleApprovalClick(fake.interaction, deps({ status: 'closed', note: 'the post is gone' }));
    expect(fake.responses[1]).toMatchObject({ method: 'editReply', content: `${LINE}\n-# ✖ the post is gone` });
    expect(claimApproval(id, NOW).status).toBe('done');
  });

  it('says an expired offer is too late, without acting', async () => {
    const id = createApproval(REACTION, NOW - 120_000, NOW - 60_000);
    const d = deps({ status: 'done', note: 'x' });
    const fake = click(id);

    await handleApprovalClick(fake.interaction, d);
    expect(d.execute).not.toHaveBeenCalled();
    expect(fake.responses).toEqual([
      expect.objectContaining({ method: 'update', content: `${LINE}\n-# ${APPROVAL_LINES.expired}` }),
    ]);
  });

  it('drops the button of an offer it no longer knows', async () => {
    const fake = click(404);
    await handleApprovalClick(fake.interaction, deps({ status: 'done', note: 'x' }));
    expect(fake.responses.map((r) => r.method)).toEqual(['update', 'followUp']);
    expect(fake.responses[0].options).toMatchObject({ components: [] });
    expect(fake.texts()).toEqual([APPROVAL_LINES.unknown]);
  });

  it('answers a malformed custom id privately', async () => {
    const fake = click('sa:nope');
    await handleApprovalClick(fake.interaction, deps({ status: 'done', note: 'x' }));
    expect(fake.texts()).toEqual([APPROVAL_LINES.unknown]);
  });
});
