import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CIRCLE_MIN_PRESENT,
  correctionLine,
  circleNames,
  circlesNamedIn,
  describeMembers,
  describeParticipants,
  excerpt,
  formatNoteSize,
  OCCASION_MAX_CHARS,
  pickCircles,
  pickOccasions,
  renderOccasionNote,
  profileSummary,
  renderGroupSection,
} from './context';
import type { Note } from './notesStore';

const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const JASPER = '100000000000000004';
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
    status: null,
    startsOn: null,
    endsOn: null,
    place: null,
    circle: null,
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

  it('brings a fading circle in only when the message names it', () => {
    const fading = circle(1);
    const present = new Set([REMI, DALE]);
    expect(pickCircles({ circles: [fading], text: 'hi', present, canBePresent: () => false })).toEqual([]);
    expect(
      pickCircles({ circles: [fading], text: 'mtg tonight?', present, canBePresent: () => false }).map((p) => p.reason),
    ).toEqual(['named']);
  });
});

describe('occasions in a chat turn', () => {
  const today = '2027-01-01';
  const occasion = (id: number, over: Partial<Note> = {}): Note =>
    circle(id, {
      scope: 'occasion',
      topic: 'ski-trip-2027',
      title: 'Ski trip',
      aliases: ['the ski trip'],
      content: 'The group trip.\n\n## So far\nNothing yet.\n\n## Plan\nFlights booked, hotel still open.\n\n## Earlier\n- First talked about in 2025.',
      members: [
        { memberId: REMI, since: null, until: null, role: 'organizer' },
        { memberId: DALE, since: null, until: null, role: null },
        { memberId: NOVA, since: null, until: '2026-12', role: 'bailed' },
      ],
      status: 'planned',
      startsOn: '2027-01-10',
      endsOn: '2027-01-17',
      place: 'Tremblant',
      ...over,
    });

  it('picks named occasions, then upcoming (≤60 days) or happening ones someone here takes part in, at most 2', () => {
    const soon = occasion(1);
    const far = occasion(2, { topic: 'lan-2027', title: 'Summer LAN', aliases: [], startsOn: '2027-07-01', endsOn: null });
    const now = occasion(3, { topic: 'ski-trip', title: 'Ski trip', aliases: [], startsOn: '2026-12-30', endsOn: '2027-01-03' });
    const past = occasion(4, { topic: 'bbq', title: 'The BBQ', aliases: [], status: 'past', startsOn: '2026-08-01', endsOn: null });
    const archived = occasion(5, { topic: 'old-lan', title: 'Old LAN', aliases: [], status: 'archived' });
    const all = [soon, far, now, past, archived];
    const pick = (text: string, present: string[], max?: number) =>
      pickOccasions({ occasions: all, text, present: new Set(present), today, max }).map((p) => [p.occasion.topic, p.reason]);
    expect(pick('so hyped', [REMI])).toEqual([
      ['ski-trip', 'participants'],
      ['ski-trip-2027', 'participants'],
    ]);
    // A past occasion only when named; an archived one never; someone who bailed doesn't bring it in.
    expect(pick('remember the bbq?', [JASPER])).toEqual([['bbq', 'named']]);
    expect(pick('old lan was fun', [REMI], 5).map((p) => p[0])).not.toContain('old-lan');
    expect(pick('anyone around?', [NOVA])).toEqual([]);
    expect(pick('what about the summer lan', [JASPER])).toEqual([['lan-2027', 'named']]);
    expect(
      pickOccasions({ occasions: all, text: 'hey', present: new Set([REMI]), today, skip: (o) => o.id === 3 }).map(
        (p) => p.occasion.topic,
      ),
    ).toEqual(['ski-trip-2027']);
  });

  it('renders an occasion with its dates, where it is, its people, and its Plan first', () => {
    const text = renderOccasionNote({
      occasion: occasion(1),
      reason: 'participants',
      maxChars: OCCASION_MAX_CHARS,
      nameOf: (id) => NAMES[id],
      now: new Date('2027-01-01T12:00:00Z'),
      today,
    });
    expect(text.split('\n')[0]).toBe(
      'Your notes on the occasion "Ski trip" (2027-01-10 to 2027-01-17 in Tremblant; planned, starts in 9 days; with Remi (organizer), Dale; dropped out: Nova (until 2026-12, bailed); some of its people are in this conversation; updated 3mo ago):',
    );
    expect(text).toContain('The group trip.\n\n## Plan\nFlights booked, hotel still open.\n\n## So far\nNothing yet.');
    expect(text).not.toContain('First talked about');
  });

  it('describes participants: who is in, then who dropped out', () => {
    expect(describeParticipants(occasion(1).members, (id) => NAMES[id])).toBe(
      'Remi (organizer), Dale; dropped out: Nova (until 2026-12, bailed)',
    );
  });
});

describe('correctionLine', () => {
  const now = new Date('2026-09-20T12:00:00Z');
  const row = (said_by: string, subject_user_id: string) => ({
    content: 'Quit Valorant in August.',
    updated_at: '2026-09-20 11:00:00',
    said_by,
    subject_user_id,
  });
  const nameOf = (id: string) => NAMES[id] ?? (id === REMI_ALT ? 'Remi' : undefined);
  const REMI_ALT = '100000000000000011';

  afterEach(() => vi.unstubAllEnvs());

  it("tells a person's own correction from someone else's claim", () => {
    expect(correctionLine(row(REMI, REMI), nameOf, now)).toBe('- Remi, about themself: Quit Valorant in August. (today)');
    expect(correctionLine(row(DALE, REMI), nameOf, now)).toBe('- Dale says: Quit Valorant in August. (today)');
  });

  it('keeps a correction filed from an account later linked as a side account their own', () => {
    // Filed from REMI_ALT about themself; the owner then linked REMI_ALT to REMI, and the startup stamp moved
    // the row's subject to REMI (said_by keeps the account that spoke).
    vi.stubEnv('LINKED_ACCOUNTS', `${REMI_ALT}:${REMI}`);
    expect(correctionLine(row(REMI_ALT, REMI), nameOf, now)).toBe(
      '- Remi, about themself: Quit Valorant in August. (today)',
    );
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
