import { describe, expect, it } from 'vitest';
import {
  CIRCLE_MIN_PRESENT,
  circleNames,
  circlesNamedIn,
  describeMembers,
  excerpt,
  formatNoteSize,
  pickCircles,
  profileSummary,
  renderGroupSection,
} from './context';
import type { Note } from './notesStore';

const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const NAMES: Record<string, string> = { [REMI]: 'Remi', [DALE]: 'Dale', [NOVA]: 'Nova' };

function circle(id: number, over: Partial<Note> = {}): Note {
  return {
    id,
    scope: 'circle',
    ownerId: null,
    topic: 'mtg',
    title: 'The MTG crew',
    content: 'Friday drafts.',
    aliases: ['the drafters'],
    members: [
      { memberId: REMI, since: '2021', until: null, role: 'organizer' },
      { memberId: DALE, since: '2021', until: null, role: null },
      { memberId: NOVA, since: '2019', until: '2023', role: null },
    ],
    version: 1,
    updatedAt: '2026-09-20 12:00:00',
    updatedBy: 'dream',
    active: true,
    ...over,
  };
}

describe('circle names', () => {
  it('matches the title with or without "the", the slug as words and aliases, as whole words', () => {
    expect(circleNames(circle(1))).toEqual(['the mtg crew', 'mtg crew', 'mtg', 'the drafters']);
    const circles = [circle(1), circle(2, { topic: 'valorant-squad', title: 'Valorant squad', aliases: [] })];
    expect(circlesNamedIn('MTG tonight?', circles).map((c) => c.id)).toEqual([1]);
    expect(circlesNamedIn('the Drafters are back', circles).map((c) => c.id)).toEqual([1]);
    expect(circlesNamedIn('valorant squad on?', circles).map((c) => c.id)).toEqual([2]);
    expect(circlesNamedIn('mtgx and valorantsquad', circles)).toEqual([]);
  });
});

describe('pickCircles', () => {
  it('puts named circles first, then circles with enough current members present, skipping shown ones', () => {
    const named = circle(1);
    const pair = circle(2, {
      topic: 'dale-and-nova',
      title: 'Dale & Nova',
      aliases: [],
      members: [
        { memberId: DALE, since: null, until: null, role: null },
        { memberId: NOVA, since: null, until: null, role: null },
      ],
    });
    const present = new Set([DALE, NOVA]);
    expect(pickCircles({ circles: [pair, named], text: 'mtg later', present }).map((p) => [p.circle.id, p.reason])).toEqual([
      [1, 'named'],
      [2, 'members'],
    ]);
    // A former member doesn't count toward presence.
    expect(CIRCLE_MIN_PRESENT).toBe(2);
    expect(pickCircles({ circles: [named], text: 'hi', present: new Set([REMI, NOVA]) })).toEqual([]);
    expect(pickCircles({ circles: [named], text: 'hi', present: new Set([REMI, DALE]) })).toHaveLength(1);
    expect(pickCircles({ circles: [named], text: 'mtg', present, skip: () => true })).toEqual([]);
  });
});

describe('describeMembers', () => {
  it('lists current members, then former ones, with spans and roles', () => {
    expect(describeMembers(circle(1).members, (id) => NAMES[id])).toBe(
      'Remi (since 2021, organizer), Dale (since 2021); formerly Nova (2019–2023)',
    );
  });
});

describe('profileSummary and excerpt', () => {
  it('flattens the profile without its Earlier part', () => {
    expect(profileSummary('## Now\n- **Night owl**, bakes bread.\n\n## Earlier\n- Played Overwatch.', 200)).toBe(
      'Night owl, bakes bread.',
    );
    expect(profileSummary('word '.repeat(100), 20)).toHaveLength(20);
  });

  it('cuts at a paragraph boundary with an ellipsis line', () => {
    expect(excerpt(`${'a'.repeat(50)}\n\n${'b'.repeat(50)}`, 70)).toBe(`${'a'.repeat(50)}\n…`);
    expect(formatNoteSize(640)).toBe('640 chars');
    expect(formatNoteSize(3210)).toBe('3.2k chars');
  });
});

describe('renderGroupSection', () => {
  it('carries vibe then lore without their Earlier parts', () => {
    const note = (topic: string, content: string) =>
      ({ ...circle(topic.length), scope: 'group', topic, title: topic, content, aliases: [], members: [] }) as Note;
    const { text, notes } = renderGroupSection([
      note('lore', '## Now\nThe heist.\n## Earlier\n- old'),
      note('vibe', 'Roasts.'),
      note('games', 'x'),
    ]);
    expect(notes.map((n) => n.topic)).toEqual(['vibe', 'lore']);
    expect(text).toContain('### vibe\nRoasts.\n\n### lore\n## Now\nThe heist.');
    expect(text).not.toContain('old');
  });
});
