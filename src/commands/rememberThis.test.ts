import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMemoryStoreForTesting } from '../ai/memory';
import { MemoryStore } from '../ai/memory/memoryStore';
import { recordRelay } from '../relay';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import {
  createFakeCommandDeps,
  createFakeGuild,
  createFakeMessageCommandInteraction,
  createFakeTargetMessage,
} from '../test-support/fakeInteraction';
import { handleContextMenuCommand } from './index';
import { LINES } from './respond';
import {
  MAX_FACT_CHARS,
  REMEMBER_LINES,
  buildRememberPrompt,
  normalizeFact,
  parseRememberDecision,
} from './rememberThis';

let store: MemoryStore;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = new MemoryStore(':memory:');
  setMemoryStoreForTesting(store);
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setMemoryStoreForTesting(undefined);
  setBotDbForTesting(undefined);
  vi.restoreAllMocks();
});

function jasperSays(content: string, extra: Parameters<typeof createFakeTargetMessage>[0] = {}) {
  const { guild } = createFakeGuild({ members: { 'user-7': 'Jasper' } });
  return createFakeTargetMessage({ authorId: 'user-7', authorDisplayName: 'jay', guild, content, ...extra });
}

describe('parseRememberDecision', () => {
  it('reads a fact, a refusal, and tolerates fences and prose', () => {
    expect(parseRememberDecision('{"fact": "Works as a nurse."}')).toEqual({ fact: 'Works as a nurse.', reason: undefined });
    expect(parseRememberDecision('```json\n{"fact": null, "reason": "just a joke"}\n```')).toEqual({
      fact: null,
      reason: 'just a joke',
    });
    expect(parseRememberDecision('Sure! {"fact": ""}')).toEqual({ fact: null, reason: undefined });
  });

  it('rejects anything else', () => {
    expect(parseRememberDecision('no json here')).toBeUndefined();
    expect(parseRememberDecision('{"memory": "x"}')).toBeUndefined();
    expect(parseRememberDecision('{"fact": 42}')).toBeUndefined();
    expect(parseRememberDecision('{broken')).toBeUndefined();
  });
});

describe('normalizeFact', () => {
  it('strips emoji syntax, quotes and extra whitespace', () => {
    expect(normalizeFact('  "Loves   poutine <:pog:123456> <a:dance:999>"  ')).toBe('Loves poutine');
  });

  it(`holds the fact to ${MAX_FACT_CHARS} characters at a word boundary`, () => {
    const long = 'Works as a senior backend engineer at a logistics startup in downtown Montreal since last spring';
    const fact = normalizeFact(long);
    expect(fact.length).toBeLessThanOrEqual(MAX_FACT_CHARS);
    expect(long.startsWith(fact)).toBe(true);
    expect(fact.endsWith(' ')).toBe(false);
  });
});

describe('buildRememberPrompt', () => {
  it("carries the learner's rules", () => {
    const prompt = buildRememberPrompt('Jasper');
    expect(prompt).toContain('THE 30-DAY TEST');
    expect(prompt).toContain(`at most ${MAX_FACT_CHARS} characters`);
    expect(prompt).toContain('ALREADY KNOWN');
    expect(prompt).toMatch(/emoji/);
    expect(prompt).toContain('Jasper');
  });
});

describe('Remember this', () => {
  it("saves one fact about the author under their current name and id, and confirms privately", async () => {
    await store.save({ category: 'fact', subject: 'Jasper', content: 'Still plays on PS4.', subject_user_id: 'user-7' });
    const target = jasperSays('just got hired as a nurse at the Jewish General lol');
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Remember this' });
    const { deps, recorders } = createFakeCommandDeps({
      store,
      complete: async () => '{"fact": "Works as a nurse at the Jewish General Hospital."}',
    });

    await handleContextMenuCommand(interaction, deps);

    const request = recorders.complete.calls[0][0];
    expect(request.system).toBe(buildRememberPrompt('Jasper'));
    expect(request.user).toContain('Today (Eastern time): 2026-09-25');
    expect(request.user).toContain('- Still plays on PS4.');
    expect(request.user).toContain('just got hired as a nurse at the Jewish General lol');

    const saved = store.getForPerson({ userId: 'user-7', names: [] }).find((m) => m.source === 'command');
    expect(saved).toMatchObject({
      category: 'fact',
      subject: 'Jasper',
      subject_user_id: 'user-7',
      content: 'Works as a nurse at the Jewish General Hospital.',
    });
    expect(responses.at(-1)).toMatchObject({
      method: 'editReply',
      ephemeral: true,
      content: `got it, memory #${saved?.id} about Jasper: Works as a nurse at the Jewish General Hospital.`,
    });
  });

  it("shows the model what is already known under any of the author's names (IRL name, Discord handle)", async () => {
    store.upsertIdentity('user-7', 'Jasper');
    store.updateIdentityMeta('user-7', { irl_name: 'Jasper M' });
    await store.save({ category: 'fact', subject: 'Jasper M', content: 'Grew up in Laval.' });
    await store.save({ category: 'preference', subject: 'lapinlune', content: 'Mains Thresh.' });
    await store.save({ category: 'fact', subject: 'Silas', content: 'Drives a Civic.' });
    const target = jasperSays('moving back to laval next month', { authorUsername: 'lapinlune' });
    const { interaction } = createFakeMessageCommandInteraction(target.message, { commandName: 'Remember this' });
    const { deps, recorders } = createFakeCommandDeps({ store, complete: async () => '{"fact": null}' });

    await handleContextMenuCommand(interaction, deps);

    const user = recorders.complete.calls[0][0].user;
    expect(user).toContain('- Grew up in Laval.');
    expect(user).toContain('- Mains Thresh.');
    expect(user).not.toContain('Civic');
  });

  it('reports when nothing durable is in the message, saving nothing', async () => {
    const target = jasperSays('lmaooo');
    const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Remember this' });
    const { deps } = createFakeCommandDeps({ store, complete: async () => '{"fact": null, "reason": "Just a reaction."}' });

    await handleContextMenuCommand(interaction, deps);

    expect(store.getAllActive()).toHaveLength(0);
    expect(responses.at(-1)).toMatchObject({ content: `${REMEMBER_LINES.nothingDurable} (Just a reaction)` });
  });

  it('attributes a link-fix repost to the member it was posted for', async () => {
    recordRelay({ messageId: 'relay-1', channelId: 'channel-1', authorId: 'user-8', authorName: 'Silas', kind: 'link_fix' });
    const { guild } = createFakeGuild({ members: { 'user-8': 'Silas B' } });
    const target = createFakeTargetMessage({
      messageId: 'relay-1',
      webhookId: 'hook-1',
      authorUsername: 'Silas',
      guild,
      content: 'my new car https://fxtwitter.com/x/status/1',
    });
    const { interaction } = createFakeMessageCommandInteraction(target.message, { commandName: 'Remember this' });
    const { deps } = createFakeCommandDeps({ store, complete: async () => '{"fact": "Drives a Civic Type R."}' });

    await handleContextMenuCommand(interaction, deps);

    expect(store.getAllActive()[0]).toMatchObject({ subject: 'Silas B', subject_user_id: 'user-8', source: 'command' });
  });

  it("files a linked side account's message under the main account (LINKED_ACCOUNTS)", async () => {
    vi.stubEnv('LINKED_ACCOUNTS', '100000000000000002:100000000000000001');
    try {
      store.upsertIdentity('100000000000000001', 'Toby', 'toby_main');
      store.upsertIdentity('100000000000000002', 'Tohbee', 'tobyclone');
      // Already known, filed under the side account's name: shown to the model as known.
      await store.save({ category: 'fact', subject: 'Tohbee', content: 'Owns a canoe.' });
      const { guild } = createFakeGuild({ members: { '100000000000000001': 'Toby' } });
      const target = createFakeTargetMessage({
        authorId: '100000000000000002',
        authorDisplayName: 'Tohbee',
        authorUsername: 'tobyclone',
        guild,
        content: 'just moved to laval',
      });
      const { interaction } = createFakeMessageCommandInteraction(target.message, { commandName: 'Remember this' });
      const { deps, recorders } = createFakeCommandDeps({ store, complete: async () => '{"fact": "Lives in Laval."}' });

      await handleContextMenuCommand(interaction, deps);

      expect(recorders.complete.calls[0][0].user).toContain('- Owns a canoe.');
      expect(store.getAllActive().find((m) => m.source === 'command')).toMatchObject({
        subject: 'Toby',
        subject_user_id: '100000000000000001',
        content: 'Lives in Laval.',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses the voice message transcript', async () => {
    const target = jasperSays('', {
      voiceMessage: true,
      mediaAttachments: [{ url: 'https://cdn/v.ogg', contentType: 'audio/ogg' }],
    });
    const { interaction } = createFakeMessageCommandInteraction(target.message, { commandName: 'Remember this' });
    const { deps, recorders } = createFakeCommandDeps({
      store,
      getCachedTranscript: () => 'I moved to Quebec City',
      complete: async () => '{"fact": "Lives in Quebec City."}',
    });

    await handleContextMenuCommand(interaction, deps);

    expect(recorders.complete.calls[0][0].user).toContain('[voice message] I moved to Quebec City');
    expect(store.getAllActive()[0].content).toBe('Lives in Quebec City.');
  });

  it('refuses bot messages, its own messages and empty ones without calling the model', async () => {
    const cases = [
      { target: createFakeTargetMessage({ authorId: 'other-bot', authorIsBot: true, content: 'beep' }), line: REMEMBER_LINES.notAPerson },
      { target: createFakeTargetMessage({ authorId: 'bot-1', authorIsBot: true, content: 'me' }), line: REMEMBER_LINES.ownMessage },
      {
        target: jasperSays('', { attachments: [{ url: 'https://cdn/p.png', contentType: 'image/png' }] }),
        line: REMEMBER_LINES.nothingToRead,
      },
    ];
    for (const { target, line } of cases) {
      const { interaction, responses } = createFakeMessageCommandInteraction(target.message, { commandName: 'Remember this' });
      const { deps, recorders } = createFakeCommandDeps({ store });
      await handleContextMenuCommand(interaction, deps);
      expect(responses.at(-1)?.content).toBe(line);
      expect(responses.at(-1)?.ephemeral).toBe(true);
      expect(recorders.complete.calls).toHaveLength(0);
    }
    expect(store.getAllActive()).toHaveLength(0);
  });

  it('handles an unparseable model answer and a model outage in character', async () => {
    const garbled = createFakeMessageCommandInteraction(jasperSays('I hate cilantro').message, { commandName: 'Remember this' });
    await handleContextMenuCommand(garbled.interaction, createFakeCommandDeps({ store, complete: async () => 'hmm' }).deps);
    expect(garbled.responses.at(-1)?.content).toBe(REMEMBER_LINES.unreadable);

    const down = createFakeMessageCommandInteraction(jasperSays('I hate cilantro').message, { commandName: 'Remember this' });
    await handleContextMenuCommand(
      down.interaction,
      createFakeCommandDeps({
        store,
        complete: async () => {
          throw new Error('502');
        },
      }).deps,
    );
    expect(down.responses.at(-1)?.content).toBe(LINES.failed);
    expect(store.getAllActive()).toHaveLength(0);
  });
});
