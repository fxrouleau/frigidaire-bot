import { type APIEmbed, ComponentType, TextInputStyle } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../ai/memory/memoryStore';
import { NotesStore } from '../ai/memory/notes/notesStore';
import { NOTE_LIMITS } from '../ai/memory/notes/schema';
import {
  DISCORD_LIMITS,
  type EditPreview,
  editModal,
  embedLength,
  isExpired,
  ownerWithin,
  PAGE_CHARS,
  paginate,
  parseViewerCustomId,
  renderPreview,
  renderViewer,
  VIEWER_TTL_MS,
  type ViewerContext,
  viewerOptions,
} from './notesViewer';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const NOW = new Date('2026-09-25T16:00:00Z');

let memory: MemoryStore;
let notes: NotesStore;

beforeEach(() => {
  memory = new MemoryStore(':memory:');
  notes = new NotesStore(memory, { now: () => new Date('2026-09-20T12:00:00Z') });
  memory.upsertIdentity(REMI, 'Remi');
  memory.upsertIdentity(DALE, 'Dale');
  memory.upsertIdentity(NOVA, 'Nova');
});

afterEach(() => {
  memory.close();
});

const ctx = (over: Partial<ViewerContext> = {}): ViewerContext => ({ memory, notes, now: NOW, owner: true, ...over });
const remi = { scope: 'person', ownerId: REMI } as const;

function allCustomIds(payload: ReturnType<typeof renderViewer>): string[] {
  return payload.components.flatMap((row) =>
    row.components.map((c) => ('custom_id' in c && typeof c.custom_id === 'string' ? c.custom_id : '')),
  );
}

describe('custom ids', () => {
  it('round-trip every action and stay within 100 characters', () => {
    const longId = '1'.repeat(21);
    notes.writeNotes(remi, [{ topic: 'profile', title: 'Remi', content: 'v1' }], { updatedBy: 'dream' });
    notes.writeNotes(remi, [{ topic: 'profile', title: 'Remi', content: 'v2 '.repeat(1300) }], { updatedBy: 'dream' });
    const payload = renderViewer({ subject: { kind: 'person', id: REMI }, screen: { kind: 'home' }, page: 1 }, ctx());
    const ids = allCustomIds(payload);
    expect(ids.map((id) => parseViewerCustomId(id)?.action)).toEqual(['select', 'page', 'page', 'edit', 'undo']);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(DISCORD_LIMITS.customId);

    const worst = `nv:u:p${longId}:999999999999:999999999999:${Math.floor(NOW.getTime() / 1000).toString(36)}`;
    expect(worst.length).toBeLessThanOrEqual(100);
    expect(parseViewerCustomId(worst)).toMatchObject({ action: 'undo', subject: { kind: 'person', id: longId } });
  });

  it('decode the subject, screen, page and time', () => {
    const t = Math.floor(NOW.getTime() / 1000).toString(36);
    expect(parseViewerCustomId(`nv:pn:p${REMI}:n42:3:${t}`)).toEqual({
      action: 'page',
      subject: { kind: 'person', id: REMI },
      screen: { kind: 'note', noteId: 42 },
      page: 3,
      issuedAt: Math.floor(NOW.getTime() / 1000),
    });
    expect(parseViewerCustomId('nv:m:g:j')).toEqual({
      action: 'modal',
      subject: { kind: 'group' },
      screen: { kind: 'journal' },
    });
    expect(parseViewerCustomId(`nv:c:tok_en-1:${t}`)).toMatchObject({ action: 'confirm', token: 'tok_en-1' });
  });

  it('reject anything malformed', () => {
    for (const bad of [
      'other:thing',
      'nv:',
      'nv:zz:g:1',
      'nv:s:g',
      'nv:s:q123:abc',
      'nv:s:p:abc',
      'nv:pp:g:n4:1',
      'nv:pp:g:nX:1:abc',
      'nv:u:g:1:2:ABC',
      'nv:c:bad token:abc',
      'nv:m:g:j:extra',
      `nv:s:g:${'a'.repeat(120)}`,
    ]) {
      expect(parseViewerCustomId(bad)).toBeUndefined();
    }
  });

  it('expire 15 minutes after they were issued (and refuse ones from the future)', () => {
    const issued = Math.floor(NOW.getTime() / 1000);
    expect(isExpired(issued, new Date(NOW.getTime() + VIEWER_TTL_MS - 1000))).toBe(false);
    expect(isExpired(issued, new Date(NOW.getTime() + VIEWER_TTL_MS + 1000))).toBe(true);
    expect(isExpired(issued + 3600, NOW)).toBe(true);
  });
});

describe('paginate', () => {
  it('keeps short notes whole', () => {
    expect(paginate('## Now\nShort.')).toEqual(['## Now\nShort.']);
    expect(paginate('')).toEqual(['']);
  });

  it('breaks before a heading, then at blank lines, never past the page size, losing nothing', () => {
    const sections = Array.from({ length: 12 }, (_, i) => `## Part ${i}\n${`Sentence ${i} about Remi. `.repeat(20)}`);
    const text = sections.join('\n\n');
    const pages = paginate(text, 1500);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(1500);
      expect(page.startsWith('## Part')).toBe(true);
    }
    expect(pages.join('\n\n').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' ').trim());
  });

  it('hard-cuts a page with no break in it', () => {
    const pages = paginate('x'.repeat(9000), PAGE_CHARS);
    expect(pages.map((p) => p.length)).toEqual([PAGE_CHARS, PAGE_CHARS, 9000 - 2 * PAGE_CHARS]);
  });

  it("keeps a nested list item's indentation when a page starts with it", () => {
    const text = `- ${'a'.repeat(60)}\n  - nested item`;
    expect(paginate(text, 70)).toEqual([`- ${'a'.repeat(60)}`, '  - nested item']);
  });
});

describe('ownerWithin', () => {
  it("passes the check's answer through, and reads a failing check as not the owner", async () => {
    expect(await ownerWithin(Promise.resolve(true))).toBe(true);
    expect(await ownerWithin(Promise.resolve(false))).toBe(false);
    expect(await ownerWithin(Promise.reject(new Error('Discord is down')))).toBe(false);
  });

  it("answers undefined when the check doesn't come back in time", async () => {
    expect(await ownerWithin(new Promise<boolean>(() => {}), 5)).toBeUndefined();
  });
});

describe('renderViewer limits', () => {
  it('fits a maximum-size profile, its pending corrections and a big circle within Discord embed limits', async () => {
    const big = `## Now\n${'Remi does many things with many people. '.repeat(200)}`.slice(0, NOTE_LIMITS.profileMaxChars);
    expect(notes.writeNotes(remi, [{ topic: 'profile', title: 'Remi', content: big }], { updatedBy: 'dream' }).ok).toBe(
      true,
    );
    const members = Array.from({ length: 30 }, (_, i) => {
      const id = `1000000000000001${String(i).padStart(2, '0')}`;
      memory.upsertIdentity(id, `Member With A Long Name ${i}`);
      return { id, since: '2021-01', until: i % 2 ? '2023-02' : null, role: 'longtime organizer' };
    });
    members[0] = { id: REMI, since: '2021', until: null, role: 'founder' };
    expect(
      notes.writeCircles(
        [
          {
            slug: 'mtg',
            title: 'The MTG crew',
            content: `## Now\n${'Friday drafts. '.repeat(500)}`.slice(0, NOTE_LIMITS.circleMaxChars),
            aliases: Array.from({ length: 8 }, (_, i) => `magic crew number ${i}`),
            members,
            merged_from: [],
          },
        ],
        { updatedBy: 'dream' },
      ).ok,
    ).toBe(true);

    const circle = notes.getCircle('mtg');
    for (const state of [
      { subject: { kind: 'person' as const, id: REMI }, screen: { kind: 'home' as const }, page: 0 },
      { subject: { kind: 'person' as const, id: REMI }, screen: { kind: 'note' as const, noteId: circle?.id ?? 0 }, page: 0 },
    ]) {
      const payload = renderViewer(state, ctx());
      const embed = payload.embeds[0] as APIEmbed;
      expect(embed.description?.length).toBeLessThanOrEqual(DISCORD_LIMITS.embedDescription);
      for (const f of embed.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldValue);
      expect(embedLength(embed)).toBeLessThanOrEqual(DISCORD_LIMITS.embedTotal);
    }
  });

  it('never offers more than 25 menu entries', () => {
    notes.writeNotes(
      remi,
      Array.from({ length: 10 }, (_, i) => ({
        topic: i === 0 ? 'profile' : `topic-${i}`,
        title: `Topic ${i}`,
        content: '## Now\nSomething.',
      })),
      { updatedBy: 'dream' },
    );
    for (let i = 0; i < 12; i++) {
      notes.writeCircles(
        [
          {
            slug: `circle-${i}`,
            title: `Circle ${i}`,
            content: '## Now\nThey hang out.',
            aliases: [],
            members: [{ id: REMI }, { id: DALE }],
            merged_from: [],
          },
        ],
        { updatedBy: 'dream' },
      );
    }
    for (let i = 0; i < 12; i++) {
      notes.writeCircles(
        [
          {
            slug: `old-${i}`,
            title: `Old circle ${i}`,
            content: '## Now\nNot anymore.',
            aliases: [],
            members: [
              { id: REMI, until: '2020' },
              { id: NOVA },
            ],
            merged_from: [],
          },
        ],
        { updatedBy: 'dream' },
      );
    }
    expect(notes.circlesOf(REMI, { includeFormer: true })).toHaveLength(24);
    const options = viewerOptions({ kind: 'person', id: REMI }, ctx());
    expect(options).toHaveLength(DISCORD_LIMITS.selectOptions);
    expect(options[options.length - 1].label).toBe('Raw memories');
    for (const o of options) {
      expect(o.label.length).toBeLessThanOrEqual(100);
      expect(o.description.length).toBeLessThanOrEqual(100);
    }
  });

  it('says so when the shown note is gone and falls back to the profile', () => {
    notes.writeNotes(
      remi,
      [
        { topic: 'profile', title: 'Remi', content: '## Now\nHere.' },
        { topic: 'games', title: 'Games', content: '## Now\nValorant.' },
      ],
      { updatedBy: 'dream' },
    );
    const games = notes.getNote(remi, 'games');
    notes.writeNotes(remi, [], { updatedBy: 'dream', removeTopics: ['games'] });
    const payload = renderViewer(
      { subject: { kind: 'person', id: REMI }, screen: { kind: 'note', noteId: games?.id ?? 0 }, page: 0 },
      ctx(),
    );
    expect(payload.content).toBe("that note's gone (removed or merged), here's what's left");
    expect(payload.embeds[0].title).toBe('Remi');
  });
});

describe('editModal', () => {
  it('asks "What should change?" in a paragraph input of up to 4,000 characters', () => {
    const modal = editModal({ kind: 'person', id: REMI }, { kind: 'note', noteId: 7 }, `Edit notes on ${'Remi'.repeat(20)}`);
    expect(modal.title.length).toBeLessThanOrEqual(45);
    expect(parseViewerCustomId(modal.custom_id)).toEqual({
      action: 'modal',
      subject: { kind: 'person', id: REMI },
      screen: { kind: 'note', noteId: 7 },
    });
    const label = modal.components[0];
    expect(label.type).toBe(ComponentType.Label);
    if (label.type !== ComponentType.Label) return;
    expect(label.label).toBe('What should change?');
    expect(label.component).toMatchObject({
      type: ComponentType.TextInput,
      custom_id: 'instruction',
      style: TextInputStyle.Paragraph,
      max_length: 4000,
      required: true,
    });
  });
});

describe('renderPreview', () => {
  const preview = (over: Partial<EditPreview> = {}): EditPreview => ({
    token: 'tok123',
    changeSummary: 'moved to Laval',
    instruction: 'Remi moved to Laval in August',
    expiresAt: NOW.getTime() + VIEWER_TTL_MS,
    changes: [
      {
        kind: 'note',
        key: 'profile',
        title: 'Remi',
        change: 'changed',
        before: '## Now\nLives in Verdun.',
        after: '## Now\nLives in Laval since August 2026.',
      },
      {
        kind: 'circle',
        key: 'mtg',
        title: 'The MTG crew',
        change: 'changed',
        before: '## Now\nFriday drafts.',
        after: '## Now\nFriday drafts.',
        membersBefore: [{ memberId: REMI, since: '2021', until: null, role: null }],
        membersAfter: [
          { memberId: REMI, since: '2021', until: null, role: null },
          { memberId: DALE, since: '2026', until: null, role: null },
        ],
        aliasesBefore: [],
        aliasesAfter: ['magic crew'],
      },
    ],
    ...over,
  });

  it('shows one change per page as a diff, with Confirm and Cancel', () => {
    const payload = renderPreview(preview(), 0, { memory, now: NOW });
    expect(payload.content).toContain('**Edit preview** · 2 changes: moved to Laval');
    expect(payload.content).toContain('you asked: Remi moved to Laval in August');
    expect(payload.content).toContain(`<t:${Math.floor((NOW.getTime() + VIEWER_TTL_MS) / 1000)}:R>`);
    const embed = payload.embeds[0];
    expect(embed.author?.name).toBe('Change 1/2 · changed');
    expect(embed.title).toBe('Remi (profile)');
    expect(embed.description).toContain('- Lives in Verdun.');
    expect(embed.description).toContain('+ Lives in Laval since August 2026.');
    const labels = payload.components.flatMap((r) => r.components.map((c) => ('label' in c ? c.label : '')));
    expect(labels).toEqual(['◀ Previous change', 'Next change ▶', 'Confirm', 'Cancel']);
  });

  it("shows a circle's membership and other names before and after", () => {
    const payload = renderPreview(preview(), 1, { memory, now: NOW });
    const embed = payload.embeds[0];
    expect(embed.title).toBe('The MTG crew (circle mtg)');
    expect(embed.description).toBe('(no change to the text)');
    expect(embed.fields).toEqual([
      { name: 'Members before', value: 'Remi (since 2021)' },
      { name: 'Members after', value: 'Remi (since 2021), Dale (since 2026)' },
      { name: 'Also called', value: '— → magic crew' },
    ]);
  });

  it('keeps a huge rewrite within one embed', () => {
    const payload = renderPreview(
      preview({
        changes: [
          {
            kind: 'note',
            key: 'history',
            title: 'History',
            change: 'changed',
            before: Array.from({ length: 150 }, (_, i) => `Old line ${i} of the history note.`).join('\n'),
            after: Array.from({ length: 150 }, (_, i) => `New line ${i} of the history note.`).join('\n'),
          },
        ],
      }),
      0,
      { memory, now: NOW },
    );
    expect(embedLength(payload.embeds[0])).toBeLessThanOrEqual(DISCORD_LIMITS.embedTotal);
    expect(payload.content.length).toBeLessThanOrEqual(2000);
    // One change: no paging row.
    expect(payload.components).toHaveLength(1);
  });
});
