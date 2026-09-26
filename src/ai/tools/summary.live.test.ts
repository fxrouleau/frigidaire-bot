// Live, paid, opt-in smoke test of the "catch me up" pipeline against the real OpenRouter API (the
// configured CHAT_MODEL with ZDR-only routing). SKIPPED unless RUN_LIVE=1 and OPENROUTER_API_KEY are set.
//
//   docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... test yarn test:live
//
// One summary call on a tiny synthetic transcript: a fraction of a cent.
import { Collection, type FetchMessagesOptions, type Message, SnowflakeUtil } from 'discord.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import { setMemoryStoreForTesting } from '../memory';
import { MemoryStore } from '../memory/memoryStore';
import { summarizeChannel } from './summary';

const RUN_LIVE = process.env.RUN_LIVE === '1' && !!process.env.OPENROUTER_API_KEY;

describe.skipIf(!RUN_LIVE)('summarizeChannel live (paid, opt-in)', () => {
  afterEach(() => setMemoryStoreForTesting(undefined));

  it('summarizes a short synthetic chat through the ZDR-routed chat model, without leaking background', async () => {
    // Background memories are context only: a fact nobody said in the chat must not show up in the summary.
    const store = new MemoryStore(':memory:');
    setMemoryStoreForTesting(store);
    store.upsertIdentity('u1', 'Jasper', 'lapinlune');
    await store.save({ category: 'fact', subject: 'Jasper', subject_user_id: 'u1', content: 'Keeps eleven pet iguanas' });

    const now = new Date();
    const lines: [string, string, string][] = [
      ['u1', 'Jasper', 'who is down for wings friday at 8'],
      ['u2', 'Silas', 'me, the usual place?'],
      ['u1', 'Jasper', 'yeah, and bring the switch for mario kart after'],
      ['u3', 'Remi', 'cant, working late. save me some'],
    ];
    const history = lines.map(([authorId, name, content], i) => {
      const createdAt = new Date(now.getTime() - (lines.length - i) * 5 * 60_000);
      const messageId = SnowflakeUtil.generate({ timestamp: createdAt }).toString();
      return createFakeMessage({ authorId, authorDisplayName: name, content, createdAt, messageId }).message;
    });
    const trigger = createFakeMessage({
      authorId: 'u3',
      authorDisplayName: 'Remi',
      content: 'catch me up',
      createdAt: now,
      messageId: SnowflakeUtil.generate({ timestamp: now }).toString(),
    }).message;
    const channel = trigger.channel as unknown as {
      messages: { fetch: (opts: FetchMessagesOptions) => Promise<Collection<string, Message>> };
    };
    channel.messages.fetch = async () => new Collection([...history].reverse().map((m) => [m.id, m]));

    const result = await summarizeChannel({ message: trigger, start: new Date(now.getTime() - 60 * 60_000) });

    expect(result).toMatch(/^Summary of this channel from /);
    expect(result).not.toMatch(/model call failed|returned nothing/);
    expect(result.toLowerCase()).toContain('wings');
    expect(result.toLowerCase()).not.toContain('iguana');
    expect(result).toContain('People in this stretch: Jasper, Silas, Remi.');
  }, 60_000);
});
