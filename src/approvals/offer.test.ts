import { ButtonStyle, ComponentType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { createPostableChannel, createSchedulingClient } from '../test-support/fakeScheduling';
import { type ApprovalPayload, claimApproval } from './approvalStore';
import {
  approvalButtonRow,
  approvalCustomId,
  approvalExpiry,
  isApprovalCustomId,
  offerApproval,
  parseApprovalCustomId,
} from './offer';

const REPORT = 'report-channel';
const REACTION: ApprovalPayload = {
  kind: 'auto_react',
  channelId: 'channel-1',
  messageId: 'message-1',
  emoji: '😂',
  label: '😂',
};
const BIRTHDAY: ApprovalPayload = {
  kind: 'birthday',
  userId: '400000000000000001',
  year: 2026,
  channelId: 'birthday-channel',
  text: '🎂 happy bday',
};

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  vi.stubEnv('REPORT_CHANNEL_ID', REPORT);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setBotDbForTesting(undefined);
});

describe('approval custom ids', () => {
  it('round-trips and refuses anything else', () => {
    expect(approvalCustomId(42)).toBe('sa:42');
    expect(parseApprovalCustomId('sa:42')).toBe(42);
    expect(isApprovalCustomId('sa:42')).toBe(true);
    expect(isApprovalCustomId('nv:p1:x')).toBe(false);
    expect(parseApprovalCustomId('sa:abc')).toBeUndefined();
    expect(parseApprovalCustomId('sa:')).toBeUndefined();
  });
});

describe('approvalExpiry', () => {
  it('ends a birthday offer at Eastern midnight, DST included', () => {
    // Sept 25 15:00 EDT → Sept 26 00:00 EDT (04:00 UTC).
    expect(approvalExpiry(BIRTHDAY, Date.UTC(2026, 8, 25, 19, 0))).toBe(Date.UTC(2026, 8, 26, 4, 0));
    // Dec 31 15:00 EST → Jan 1 00:00 EST (05:00 UTC).
    expect(approvalExpiry(BIRTHDAY, Date.UTC(2026, 11, 31, 20, 0))).toBe(Date.UTC(2027, 0, 1, 5, 0));
  });

  it('gives a reaction a day', () => {
    expect(approvalExpiry(REACTION, 1000)).toBe(1000 + 24 * 60 * 60_000);
  });
});

describe('offerApproval', () => {
  it('posts the line with a button pointing at the stored offer', async () => {
    const report = createPostableChannel({ id: REPORT });
    const { client } = createSchedulingClient({ [REPORT]: report.channel });

    expect(await offerApproval(client, '-# would react 😂', REACTION, 5000)).toBe(true);
    expect(report.sent).toHaveLength(1);
    expect(report.sent[0]).toMatchObject({ content: '-# would react 😂', allowedMentions: { parse: [] } });
    const row = report.sent[0].components?.[0] as ReturnType<typeof approvalButtonRow>;
    expect(row.type).toBe(ComponentType.ActionRow);
    expect(row.components[0]).toMatchObject({ label: 'React', style: ButtonStyle.Success });
    const id = parseApprovalCustomId(row.components[0].custom_id);
    expect(claimApproval(id as number, 5000)).toMatchObject({ status: 'claimed', approval: { payload: REACTION } });
  });

  it('labels a birthday offer "Post it" and puts the button on the last chunk only', async () => {
    const report = createPostableChannel({ id: REPORT });
    const { client } = createSchedulingClient({ [REPORT]: report.channel });

    expect(await offerApproval(client, `${'a'.repeat(1990)}\n${'b'.repeat(100)}`, BIRTHDAY)).toBe(true);
    expect(report.sent).toHaveLength(2);
    expect(report.sent[0].components).toBeUndefined();
    const row = report.sent[1].components?.[0] as ReturnType<typeof approvalButtonRow>;
    expect(row.components[0].label).toBe('Post it');
  });

  it('forgets the offer when the line never went out', async () => {
    const report = createPostableChannel({
      id: REPORT,
      sendImpl: async () => {
        throw new Error('outage');
      },
    });
    const { client } = createSchedulingClient({ [REPORT]: report.channel });

    expect(await offerApproval(client, 'line', REACTION, 5000)).toBe(false);
    expect(claimApproval(1, 5000).status).toBe('unknown');
  });
});
