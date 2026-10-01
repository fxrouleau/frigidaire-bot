import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import {
  type ApprovalPayload,
  claimApproval,
  completeApproval,
  createApproval,
  deleteApproval,
  releaseApproval,
} from './approvalStore';

const NOW = 1_000_000_000;
const REACTION: ApprovalPayload = {
  kind: 'auto_react',
  channelId: 'channel-1',
  messageId: 'message-1',
  emoji: 'KEKW:500000000000000001',
  label: '<:KEKW:500000000000000001>',
};
const BIRTHDAY: ApprovalPayload = {
  kind: 'birthday',
  userId: '400000000000000001',
  year: 2026,
  channelId: 'birthday-channel',
  text: '🎂 happy bday',
};

let botDb: BotDb;

beforeEach(() => {
  botDb = new BotDb(':memory:');
  setBotDbForTesting(botDb);
});

afterEach(() => {
  setBotDbForTesting(undefined);
});

describe('approvalStore', () => {
  it('round-trips both payload kinds', () => {
    const reaction = createApproval(REACTION, NOW, NOW + 1000);
    const birthday = createApproval(BIRTHDAY, NOW, NOW + 1000);
    expect(claimApproval(reaction, NOW)).toEqual({
      status: 'claimed',
      approval: { id: reaction, payload: REACTION, createdAt: NOW, expiresAt: NOW + 1000 },
    });
    expect(claimApproval(birthday, NOW)).toMatchObject({ status: 'claimed', approval: { payload: BIRTHDAY } });
  });

  it('lets one click act: a second claim is busy until released, then done once completed', () => {
    const id = createApproval(REACTION, NOW, NOW + 60 * 60_000);
    expect(claimApproval(id, NOW).status).toBe('claimed');
    expect(claimApproval(id, NOW + 1000).status).toBe('busy');

    releaseApproval(id);
    expect(claimApproval(id, NOW + 2000).status).toBe('claimed');
    completeApproval(id, 'owner-1', NOW + 3000);
    expect(claimApproval(id, NOW + 4000).status).toBe('done');
  });

  it('takes over a claim left behind by a crash after five minutes', () => {
    const id = createApproval(REACTION, NOW, NOW + 60 * 60_000);
    expect(claimApproval(id, NOW).status).toBe('claimed');
    expect(claimApproval(id, NOW + 4 * 60_000).status).toBe('busy');
    expect(claimApproval(id, NOW + 6 * 60_000).status).toBe('claimed');
  });

  it('closes an expired offer and says so once', () => {
    const id = createApproval(BIRTHDAY, NOW, NOW + 1000);
    expect(claimApproval(id, NOW + 1001)).toMatchObject({ status: 'expired', approval: { payload: BIRTHDAY } });
    expect(claimApproval(id, NOW + 1002).status).toBe('done');
  });

  it('knows nothing of deleted, missing or unreadable rows', () => {
    const id = createApproval(REACTION, NOW, NOW + 1000);
    deleteApproval(id);
    expect(claimApproval(id, NOW).status).toBe('unknown');
    expect(claimApproval(999, NOW).status).toBe('unknown');

    botDb.db
      .prepare("INSERT INTO shadow_approvals (id, kind, payload, created_at, expires_at) VALUES (50, 'birthday', ?, ?, ?)")
      .run(JSON.stringify({ userId: 'x', year: 'soon' }), NOW, NOW + 1000);
    expect(claimApproval(50, NOW).status).toBe('unknown');
  });

  it('forgets rows older than a month when a new one is offered', () => {
    const old = createApproval(REACTION, NOW, NOW + 1000);
    createApproval(BIRTHDAY, NOW + 31 * 24 * 60 * 60_000, NOW + 32 * 24 * 60 * 60_000);
    expect(claimApproval(old, NOW).status).toBe('unknown');
  });
});
