// Memory v2 at chat time: people's notes (profile + journal newer than the notes + open corrections) in
// the per-turn context, the group's notes in the static prompt, and the fallback to plain memories for
// people without notes. The older memory behaviors live in agent.test.ts / agent.context.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeMessage, type FakeMessageOptions } from '../test-support/fakeDiscord';
import { FakeEmbeddingProvider } from '../test-support/fakeEmbeddings';
import { FakeProvider, textResponse } from '../test-support/fakeProvider';
import { AgentOrchestrator } from './agent';
import { ConversationPersistence } from './conversationPersistence';
import { getNotesStore, setMemoryStoreForTesting } from './memory';
import { MemoryStore } from './memory/memoryStore';
import type { NotesStore } from './memory/notes/notesStore';
import type { ConversationEntry } from './types';

const CH = '555000000000000001';
const BOT_ID = '900000000000000001';
const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';

const BASE: FakeMessageOptions = {
  messageId: '99000',
  channelId: CH,
  botUserId: BOT_ID,
  authorId: REMI,
  authorDisplayName: 'Remi',
  channelMessages: [],
};

let store: MemoryStore;
let notes: NotesStore;

beforeEach(() => {
  // A relevance gate nothing passes keeps the contextual journal search out of the way.
  store = new MemoryStore(':memory:', { embeddings: new FakeEmbeddingProvider(), relevanceThreshold: 0.99 });
  store.upsertIdentity(REMI, 'Remi');
  store.upsertIdentity(DALE, 'Dale');
  store.upsertIdentity(NOVA, 'Nova');
  setMemoryStoreForTesting(store);
  notes = getNotesStore(store);
  vi.stubEnv('DEBUG_CAPTURE', '0');
});

afterEach(() => {
  setMemoryStoreForTesting(undefined);
  vi.unstubAllEnvs();
});

function makeAgent(provider: FakeProvider, persistence?: ConversationPersistence): AgentOrchestrator {
  return new AgentOrchestrator({
    resolveProvider: () => provider,
    tools: [],
    timeoutMs: 60_000,
    enrichers: [],
    contextLengths: { get: async () => undefined },
    channelNotes: () => ({ notes: {}, invalid: false }),
    persistence,
  });
}

function textOf(entry: ConversationEntry | undefined): string {
  if (entry?.kind !== 'message') return '';
  return entry.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

/** The call's own dynamic context entry: the last one (earlier turns' entries stay in the window). */
function dynamicEntry(messages: ConversationEntry[]): Extract<ConversationEntry, { kind: 'message' }> | undefined {
  return messages.findLast(
    (e): e is Extract<ConversationEntry, { kind: 'message' }> =>
      e.kind === 'message' && e.role === 'developer' && textOf(e).startsWith('Current time:'),
  );
}

function dynamicText(provider: FakeProvider, call: number): string {
  return textOf(dynamicEntry(provider.calls[call].messages));
}

function writeProfile(ownerId: string, content: string): void {
  const result = notes.writeNotes(
    { scope: 'person', ownerId },
    [{ topic: 'profile', title: 'Profile', content }],
    { updatedBy: 'dream' },
  );
  if (!result.ok) throw new Error(result.errors.join('; '));
}

describe('corrections found by the contextual search', () => {
  it("say who made them: someone's claim about a person never reads as that person's fact", async () => {
    // An embedder-less store: the contextual journal search is plain keyword search, ungated.
    store = new MemoryStore(':memory:');
    store.upsertIdentity(REMI, 'Remi');
    store.upsertIdentity(DALE, 'Dale');
    store.upsertIdentity(NOVA, 'Nova');
    setMemoryStoreForTesting(store);
    await store.save({
      category: 'correction',
      subject: 'Dale',
      content: 'Dale moved to Quillport, not Brackenfield',
      subject_user_id: DALE,
      said_by: REMI,
      source: 'correction',
    });

    const provider = new FakeProvider([textResponse('ok')]);
    await makeAgent(provider).handleMention(
      createFakeMessage({ ...BASE, authorId: NOVA, authorDisplayName: 'Nova', content: 'is quillport any good' }).message,
    );

    const text = dynamicText(provider, 0);
    expect(text).toContain(
      "Relevant to this conversation:\n- [correction, Remi's claim, not settled] Dale: Dale moved to Quillport, not Brackenfield (today)",
    );
  });
});

describe("the speaker's notes", () => {
  it('shows the profile, the journal newer than it and open corrections instead of plain memories', async () => {
    await store.save({ category: 'fact', subject: 'Remi', content: 'bakes sourdough', subject_user_id: REMI });
    writeProfile(REMI, 'Remi runs night shifts at a bakery. Plays Valorant since 2024.');
    notes.recordDreamSuccess({ scope: 'person', ownerId: REMI }, notes.journalHighWater());
    await store.save({ category: 'fact', subject: 'Remi', content: 'adopted a cat named Toast', subject_user_id: REMI });
    await store.save({
      category: 'correction',
      subject: 'Remi',
      content: 'Quit Valorant in August 2026.',
      subject_user_id: REMI,
      said_by: REMI,
    });
    await store.save({
      category: 'correction',
      subject: 'Remi',
      content: 'Works days now, not nights.',
      subject_user_id: REMI,
      said_by: DALE,
    });

    const provider = new FakeProvider([textResponse('ok')]);
    await makeAgent(provider).handleMention(createFakeMessage({ ...BASE, content: 'yo' }).message);

    const text = dynamicText(provider, 0);
    expect(text).toContain('What you know about the person talking to you right now (Remi):');
    expect(text).toContain('Your notes on Remi (updated today):\nRemi runs night shifts at a bakery.');
    expect(text).toContain('Newer than your notes on Remi:\n- [fact] adopted a cat named Toast (today)');
    // Remi's own word wins over the notes; Dale's claim about Remi is only a claim.
    expect(text).toContain(
      "Remi's own corrections, newer than your notes (they win over the notes):\n- Remi, about themself: Quit Valorant in August 2026. (today)",
    );
    expect(text).toContain(
      "What others claim about Remi, newer than your notes (their word, not settled: don't repeat it as fact):\n- Dale says: Works days now, not nights. (today)",
    );
    expect(text).not.toContain('Dale says: Works days now, not nights. (today)\n- Remi, about themself');
    // What the notes already hold is not repeated as a raw memory.
    expect(text).not.toContain('bakes sourdough');
  });

  it('shows corrections about the group, once per window, until the group dream folds them in', async () => {
    await store.save({
      category: 'correction',
      subject: 'server',
      content: 'Movie night moved to Saturdays.',
      said_by: DALE,
      source: 'correction',
    });
    const provider = new FakeProvider([textResponse('one'), textResponse('two')]);
    const agent = makeAgent(provider);

    await agent.handleMention(createFakeMessage({ ...BASE, messageId: '99001', content: 'yo' }).message);
    await agent.handleMention(createFakeMessage({ ...BASE, messageId: '99002', content: 'yo again' }).message);

    expect(dynamicText(provider, 0)).toContain(
      "Corrections about the group not in your notes yet (each is the speaker's word: weigh it against what you know):\n- Dale says: Movie night moved to Saturdays. (today)",
    );
    expect(dynamicText(provider, 1)).not.toContain('Movie night');
  });

  it('shows a profile version once per window, a newer version and new journal rows again', async () => {
    writeProfile(REMI, 'Remi runs night shifts at a bakery.');
    const provider = new FakeProvider([textResponse('one'), textResponse('two'), textResponse('three')]);
    const agent = makeAgent(provider);

    await agent.handleMention(createFakeMessage({ ...BASE, messageId: '99001', content: 'yo' }).message);
    await agent.handleMention(createFakeMessage({ ...BASE, messageId: '99002', content: 'yo again' }).message);
    await store.save({ category: 'fact', subject: 'Remi', content: 'adopted a cat named Toast', subject_user_id: REMI });
    writeProfile(REMI, 'Remi runs day shifts at a bakery now.');
    await agent.handleMention(createFakeMessage({ ...BASE, messageId: '99003', content: 'and again' }).message);

    expect(dynamicText(provider, 0)).toContain('Remi runs night shifts');
    expect(dynamicText(provider, 1)).not.toContain('Your notes on Remi');
    const third = dynamicText(provider, 2);
    expect(third).toContain('Remi runs day shifts at a bakery now.');
    expect(third).toContain('- [fact] adopted a cat named Toast');
  });

  it('caps a long profile at a paragraph boundary', async () => {
    // ~3,700 characters: within the profile limit, over what one turn shows of it.
    const paragraphs = Array.from({ length: 36 }, (_, i) => `Paragraph ${i} ${'about Remi '.repeat(8)}`.trim());
    writeProfile(REMI, paragraphs.join('\n\n'));
    const provider = new FakeProvider([textResponse('ok')]);
    await makeAgent(provider).handleMention(createFakeMessage({ ...BASE, content: 'yo' }).message);

    const text = dynamicText(provider, 0);
    expect(text).toContain('Paragraph 0');
    expect(text).not.toContain('Paragraph 35');
    expect(text).toContain('\n…');
  });
});

describe("other people's notes", () => {
  it('shows notes for someone @-mentioned and plain memories for someone without notes', async () => {
    writeProfile(DALE, 'Dale plays bass in a garage band.');
    await store.save({ category: 'fact', subject: 'Nova', content: 'collects vinyl', subject_user_id: NOVA });

    const provider = new FakeProvider([textResponse('ok')]);
    await makeAgent(provider).handleMention(
      createFakeMessage({
        ...BASE,
        content: `what are <@${DALE}> and nova up to`,
        mentionedUsers: [{ id: DALE, displayName: 'Dale' }],
      }).message,
    );

    const text = dynamicText(provider, 0);
    expect(text).toContain('What you know about Dale (mentioned in this message):\nYour notes on Dale');
    expect(text).toContain('Dale plays bass in a garage band.');
    expect(text).toContain('What you know about others mentioned in this message:\n- Nova: collects vinyl');
  });

  it('marks what it showed, so a persisted window does not repeat it after a restart', async () => {
    writeProfile(REMI, 'Remi runs night shifts at a bakery.');
    const persistence = new ConversationPersistence(':memory:');
    const provider = new FakeProvider([textResponse('one'), textResponse('two')]);

    await makeAgent(provider, persistence).handleMention(
      createFakeMessage({ ...BASE, messageId: '99001', content: 'yo' }).message,
    );
    const entry = dynamicEntry(provider.calls[0].messages);
    expect(entry?.noteKeys).toEqual([`note:${notes.getProfile(REMI)?.id}@1`]);

    // A new orchestrator over the same persisted state: the profile is already in the window.
    await makeAgent(provider, persistence).handleMention(
      createFakeMessage({ ...BASE, messageId: '99002', content: 'yo again' }).message,
    );
    expect(dynamicText(provider, 1)).not.toContain('Your notes on Remi');
  });
});

describe("the group's notes", () => {
  it('replace the vibe bucket in the static prompt, which stays byte-identical', async () => {
    await store.save({ category: 'vibe', subject: 'server', content: 'OLD VIBE MEMORY' });
    notes.writeNotes(
      { scope: 'group' },
      [
        { topic: 'lore', title: 'Lore', content: 'The great bakery heist of 2022.' },
        { topic: 'vibe', title: 'Vibe', content: 'Roasts are affection here.' },
        { topic: 'games', title: 'Games', content: 'Not in the static prompt.' },
      ],
      { updatedBy: 'dream' },
    );

    const provider = new FakeProvider([textResponse('one'), textResponse('two')]);
    const agent = makeAgent(provider);
    await agent.handleMention(createFakeMessage({ ...BASE, messageId: '99001', content: 'yo' }).message);
    await agent.handleMention(createFakeMessage({ ...BASE, messageId: '99002', content: 'yo again' }).message);

    const staticPrompt = textOf(provider.calls[0].messages[0]);
    expect(staticPrompt).toContain(
      "What you know about this group (your notes on the server's vibe and lore):\n### Vibe\nRoasts are affection here.\n\n### Lore\nThe great bakery heist of 2022.",
    );
    expect(staticPrompt).not.toContain('Not in the static prompt');
    expect(staticPrompt).not.toContain('OLD VIBE MEMORY');
    expect(provider.calls[1].messages[0]).toEqual(provider.calls[0].messages[0]);
    const first = provider.calls[0].messages[0];
    expect(first.kind === 'message' && first.noteKeys?.length).toBe(2);
  });

  it('falls back to the vibe bucket before the first dream', async () => {
    await store.save({ category: 'vibe', subject: 'server', content: 'friday movie nights' });
    const provider = new FakeProvider([textResponse('ok')]);
    await makeAgent(provider).handleMention(createFakeMessage({ ...BASE, content: 'yo' }).message);
    expect(textOf(provider.calls[0].messages[0])).toContain(
      "What you've learned about this server's culture and vibe:\n- friday movie nights",
    );
  });
});

describe('profile shape at chat time', () => {
  it('leaves the dated Earlier footnotes out and says where they are, and lists their circles', async () => {
    writeProfile(
      REMI,
      '## Now\nRuns day shifts at a bakery.\n\n## Traits\nDry humor.\n\n## Earlier\n- Back in 2017 played Overwatch nightly.',
    );
    notes.writeCircles(
      [
        {
          slug: 'mtg',
          title: 'The MTG crew',
          content: 'Friday drafts.',
          members: [{ id: REMI }, { id: DALE }],
        },
      ],
      { updatedBy: 'dream' },
    );
    const provider = new FakeProvider([textResponse('ok')]);
    await makeAgent(provider).handleMention(createFakeMessage({ ...BASE, content: 'yo' }).message);

    const text = dynamicText(provider, 0);
    expect(text).toContain('## Traits\nDry humor.');
    expect(text).not.toContain('Overwatch');
    expect(text).toContain('(Older, dated history in this note is left out here: read_note shows it.)');
    expect(text).toContain('Their circles: The MTG crew.');
  });

  it("labels a correction in the plain memories of someone without notes as that person's claim", async () => {
    await store.save({
      category: 'correction',
      subject: 'Remi',
      content: 'Moved to Laval.',
      subject_user_id: REMI,
      said_by: DALE,
    });
    const provider = new FakeProvider([textResponse('ok')]);
    await makeAgent(provider).handleMention(createFakeMessage({ ...BASE, content: 'yo' }).message);
    expect(dynamicText(provider, 0)).toContain('- Dale says: Moved to Laval. (today)');
  });
});

describe('circle notes', () => {
  const circle = (over: Record<string, unknown> = {}) => ({
    slug: 'mtg',
    title: 'The MTG crew',
    content: '## Now\nFriday drafts at the game store.\n\n## Earlier\n- Started in 2019 at a basement table.',
    aliases: ['the drafters'],
    members: [
      { id: REMI, since: '2021' },
      { id: DALE, since: '2021' },
      { id: NOVA, since: '2019', until: '2023' },
    ],
    ...over,
  });

  beforeEach(() => {
    notes.writeCircles([circle()], { updatedBy: 'dream' });
  });

  it('shows a circle when two of its current members are in the conversation, once per window', async () => {
    const provider = new FakeProvider([textResponse('one'), textResponse('two')]);
    const agent = makeAgent(provider);
    await agent.handleMention(
      createFakeMessage({
        ...BASE,
        messageId: '99001',
        content: `<@${DALE}> you in friday?`,
        mentionedUsers: [{ id: DALE, displayName: 'Dale' }],
      }).message,
    );
    await agent.handleMention(
      createFakeMessage({
        ...BASE,
        messageId: '99002',
        content: `<@${DALE}> answer me`,
        mentionedUsers: [{ id: DALE, displayName: 'Dale' }],
      }).message,
    );

    const first = dynamicText(provider, 0);
    expect(first).toContain(
      'Your notes on the circle "The MTG crew" (several of its members are in this conversation; members: Remi (since 2021), Dale (since 2021); formerly Nova (2019–2023)',
    );
    expect(first).toContain('Friday drafts at the game store.');
    expect(first).not.toContain('basement table');
    expect(dynamicText(provider, 1)).not.toContain('The MTG crew" (');
  });

  it('shows a circle the message names by alias, and not for one member alone', async () => {
    const provider = new FakeProvider([textResponse('one'), textResponse('two')]);
    await makeAgent(provider).handleMention(createFakeMessage({ ...BASE, content: 'yo whats up' }).message);
    expect(dynamicText(provider, 0)).not.toContain('The MTG crew" (');

    await makeAgent(provider).handleMention(
      createFakeMessage({ ...BASE, messageId: '99010', content: 'are the Drafters still a thing' }).message,
    );
    expect(dynamicText(provider, 1)).toContain('Your notes on the circle "The MTG crew" (it came up in this message;');
  });

  it("counts the window's recent participants as present", async () => {
    const daleEarlier = createFakeMessage({
      ...BASE,
      messageId: '98999',
      authorId: DALE,
      authorDisplayName: 'Dale',
      content: 'draft night was wild',
    }).message;
    const provider = new FakeProvider([textResponse('ok')]);
    await makeAgent(provider).handleMention(
      createFakeMessage({ ...BASE, messageId: '99020', content: 'yo', channelMessages: [daleEarlier] }).message,
    );
    expect(dynamicText(provider, 0)).toContain('Your notes on the circle "The MTG crew" (several of its members');
  });
});
