import type { Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { ReactionApproval } from '../approvals/approvalStore';
import { BotDb } from '../storage/botDb';
import { discordError } from '../test-support/fakeScheduling';
import { addApprovedReaction } from './approval';
import { AutoReactLedger } from './ledger';

const APPROVAL: ReactionApproval = {
  kind: 'auto_react',
  channelId: 'main',
  messageId: 'm1',
  emoji: 'KEKW:500000000000000001',
  label: '<:KEKW:500000000000000001>',
};

function setup(opts: { channel?: 'missing' | 'voice'; message?: unknown; react?: unknown } = {}) {
  const reacted: string[] = [];
  const message = {
    url: 'https://discord.com/channels/g/main/m1',
    react: async (emoji: string) => {
      if (opts.react) throw opts.react;
      reacted.push(emoji);
    },
  };
  const channel = {
    isTextBased: () => opts.channel !== 'voice',
    messages: {
      fetch: async (id: string) => {
        if (opts.message) throw opts.message;
        if (id !== 'm1') throw discordError(10008, 'Unknown Message');
        return message;
      },
    },
  };
  const client = {
    channels: {
      fetch: async (id: string) => {
        if (opts.channel === 'missing' || id !== 'main') throw discordError(10003, 'Unknown Channel');
        return channel;
      },
    },
  } as unknown as Client;
  const db = new BotDb(':memory:');
  const ledger = new AutoReactLedger(() => db);
  ledger.claim({ messageId: 'm1', channelId: 'main', emoji: APPROVAL.label, why: 'lol', mode: 'shadow', createdAt: 1 });
  return { client, ledger, reacted };
}

describe('addApprovedReaction', () => {
  it('adds the reaction and turns the shadow ledger row into a real one', async () => {
    const { client, ledger, reacted } = setup();
    expect(await addApprovedReaction(client, APPROVAL, ledger)).toEqual({
      status: 'done',
      note: `reacted ${APPROVAL.label}`,
    });
    expect(reacted).toEqual([APPROVAL.emoji]);
    expect(ledger.since(0)).toMatchObject([{ messageId: 'm1', mode: 'on' }]);
  });

  it('closes the offer when the post or channel is gone', async () => {
    expect((await addApprovedReaction(setup().client, { ...APPROVAL, messageId: 'm2' })).status).toBe('closed');
    const missing = setup({ channel: 'missing' });
    expect(await addApprovedReaction(missing.client, APPROVAL, missing.ledger)).toEqual({
      status: 'closed',
      note: 'the post is gone',
    });
    const voice = setup({ channel: 'voice' });
    expect((await addApprovedReaction(voice.client, APPROVAL, voice.ledger)).status).toBe('closed');
  });

  it('closes it when Discord refuses the emoji, and keeps it on a hiccup', async () => {
    const refused = setup({ react: discordError(10014, 'Unknown Emoji') });
    expect(await addApprovedReaction(refused.client, APPROVAL, refused.ledger)).toEqual({
      status: 'closed',
      note: `Discord refused ${APPROVAL.label} there`,
    });
    expect(refused.ledger.since(0)).toMatchObject([{ mode: 'shadow' }]);

    const hiccup = setup({ react: new Error('socket hang up') });
    expect((await addApprovedReaction(hiccup.client, APPROVAL, hiccup.ledger)).status).toBe('retry');
  });
});
