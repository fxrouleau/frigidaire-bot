import { describe, expect, it } from 'vitest';
import {
  clampSummary,
  NOTE_LIMITS,
  normalizeTopic,
  noteTextProblems,
  parseNotesOutput,
  validateCircleDraft,
  validateNoteDraft,
  validateNotesOutput,
  validateOccasionDraft,
} from './schema';

const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';

describe('normalizeTopic', () => {
  it('accepts lowercase hyphenated slugs and lowercases them', () => {
    expect(normalizeTopic('profile')).toBe('profile');
    expect(normalizeTopic(' Running-Jokes ')).toBe('running-jokes');
    expect(normalizeTopic('games2')).toBe('games2');
  });

  it('refuses anything else', () => {
    for (const bad of ['', 'two words', 'under_score', '-lead', 'trail-', 'a--b', 'x'.repeat(33), 42, null]) {
      expect(normalizeTopic(bad), String(bad)).toBeUndefined();
    }
  });
});

describe('noteTextProblems', () => {
  it('finds Discord markup, HTML, control characters and foreign ids', () => {
    expect(noteTextProblems(`pinged <@${DALE}>`, new Set([DALE]))).toContain('contains a Discord mention');
    expect(noteTextProblems('uses <:kek:123456789012345678> a lot', new Set(['123456789012345678']))).toContain(
      'contains custom emoji syntax',
    );
    expect(noteTextProblems('see <#123>')).toContain('contains a channel mention');
    expect(noteTextProblems('at <t:1700000000:R>')).toContain('contains a Discord timestamp');
    expect(noteTextProblems('hey @everyone')).toContain('contains @everyone/@here');
    expect(noteTextProblems('<b>bold</b>')).toContain('contains an HTML tag (markdown only)');
    expect(noteTextProblems('bell\u0007')).toContain('contains control characters');
    expect(noteTextProblems(`friends with ${DALE}`)[0]).toMatch(/Discord id that wasn't in the input/);
  });

  it('accepts plain markdown, autolinks, "<3" and allowed ids', () => {
    const text = `# Remi\n\n- **Plays** Valorant (since 2024) <3\n- <https://example.com>\n\n> quote\n\`code\`\n${REMI}`;
    expect(noteTextProblems(text, new Set([REMI]))).toEqual([]);
  });
});

describe('validateNoteDraft', () => {
  it('trims and returns a valid draft', () => {
    const result = validateNoteDraft({ topic: 'Games', title: ' Games ', content: '\n- Valorant\r\n' }, { scope: 'person' });
    expect(result).toEqual({ ok: true, value: { topic: 'games', title: 'Games', content: '- Valorant' } });
  });

  it('enforces the profile and topic size limits', () => {
    const profile = validateNoteDraft(
      { topic: 'profile', title: 'Remi', content: 'x'.repeat(NOTE_LIMITS.profileMaxChars + 1) },
      { scope: 'person' },
    );
    expect(profile.ok).toBe(false);
    const topic = validateNoteDraft(
      { topic: 'games', title: 'Games', content: 'x'.repeat(NOTE_LIMITS.profileMaxChars + 1) },
      { scope: 'person' },
    );
    expect(topic.ok).toBe(true);
    const tooLong = validateNoteDraft(
      { topic: 'games', title: 'Games', content: 'x'.repeat(NOTE_LIMITS.topicMaxChars + 1) },
      { scope: 'person' },
    );
    expect(tooLong.ok).toBe(false);
  });

  it('refuses a missing title, a multi-line title, empty content and a bad shape', () => {
    expect(validateNoteDraft({ topic: 'games', content: 'x' }, { scope: 'person' }).ok).toBe(false);
    expect(validateNoteDraft({ topic: 'games', title: 'a\nb', content: 'x' }, { scope: 'person' }).ok).toBe(false);
    expect(validateNoteDraft({ topic: 'games', title: 'Games', content: '   ' }, { scope: 'person' }).ok).toBe(false);
    expect(validateNoteDraft('games', { scope: 'person' }).ok).toBe(false);
    expect(validateNoteDraft(null, { scope: 'person' }).ok).toBe(false);
  });
});

describe('validateNotesOutput', () => {
  const profile = { topic: 'profile', title: 'Remi', content: 'Remi runs the group chat.' };

  it('accepts a full output and clamps the change summary', () => {
    const result = validateNotesOutput(
      { notes: [profile], removed_topics: ['old-games'], change_summary: `new job\n${'x'.repeat(400)}` },
      { scope: 'person', requireProfile: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.removed_topics).toEqual(['old-games']);
    expect(result.value.change_summary.length).toBe(NOTE_LIMITS.changeSummaryMaxChars);
    expect(result.value.change_summary).not.toContain('\n');
  });

  it('requires the profile when asked, and never lets it be removed', () => {
    const noProfile = validateNotesOutput(
      { notes: [{ topic: 'games', title: 'Games', content: 'x' }], removed_topics: [], change_summary: '' },
      { scope: 'person', requireProfile: true },
    );
    expect(noProfile).toEqual({ ok: false, errors: ['a person\'s notes must include the "profile" topic'] });
    // A profile refused for its size is still there: only the size is wrong.
    const tooLong = validateNotesOutput(
      { notes: [{ ...profile, content: 'x'.repeat(NOTE_LIMITS.profileMaxChars + 1) }], change_summary: '' },
      { scope: 'person', requireProfile: true },
    );
    expect(tooLong).toEqual({
      ok: false,
      errors: [`note "profile": the content is ${NOTE_LIMITS.profileMaxChars + 1} characters, over the 4000 limit`],
    });
    const removal = validateNotesOutput(
      { notes: [], removed_topics: ['profile'], change_summary: '' },
      { scope: 'person' },
    );
    expect(removal.ok).toBe(false);
  });

  it('refuses duplicate topics, written-and-removed topics and too many topics', () => {
    expect(
      validateNotesOutput({ notes: [profile, profile], removed_topics: [], change_summary: '' }, { scope: 'person' }).ok,
    ).toBe(false);
    expect(
      validateNotesOutput({ notes: [profile], removed_topics: ['profile'], change_summary: '' }, { scope: 'group' }).ok,
    ).toBe(false);
    const many = Array.from({ length: NOTE_LIMITS.maxGroupTopics + 1 }, (_, i) => ({
      topic: `t${i}`,
      title: `T${i}`,
      content: 'x',
    }));
    expect(validateNotesOutput({ notes: many, removed_topics: [], change_summary: '' }, { scope: 'group' }).ok).toBe(
      false,
    );
  });

  it('collects every note error (fail closed: one bad note fails the whole output)', () => {
    const result = validateNotesOutput(
      {
        notes: [profile, { topic: 'games', title: 'Games', content: `plays with <@${DALE}>` }],
        removed_topics: [],
        change_summary: '',
      },
      { scope: 'person' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('Discord mention');
  });

  it('allows ids that were in the input', () => {
    const result = validateNotesOutput(
      { notes: [{ ...profile, content: `Best friends with Dale (${DALE}).` }], removed_topics: [], change_summary: '' },
      { scope: 'person', allowedIds: [DALE] },
    );
    expect(result.ok).toBe(true);
  });
});

describe('parseNotesOutput', () => {
  it('reads a fenced JSON answer', () => {
    const text = `Here you go:\n\`\`\`json\n${JSON.stringify({ notes: [], removed_topics: [], change_summary: 'nothing' })}\n\`\`\``;
    expect(parseNotesOutput(text, { scope: 'group' })).toEqual({
      ok: true,
      value: {
        notes: [],
        removed_topics: [],
        circles: [],
        removed_circles: [],
        archived_circles: [],
        occasions: [],
        removed_occasions: [],
        change_summary: 'nothing',
      },
    });
  });

  it('fails closed on prose', () => {
    expect(parseNotesOutput('I could not do it', { scope: 'group' }).ok).toBe(false);
  });
});

describe('clampSummary', () => {
  it('returns an empty string for anything that is not text', () => {
    expect(clampSummary(undefined)).toBe('');
    expect(clampSummary(42)).toBe('');
  });
});

describe('validateCircleDraft', () => {
  const circle = (over: Record<string, unknown> = {}) => ({
    slug: 'mtg',
    title: 'The MTG crew',
    content: '## Now\nFriday drafts at the game store.',
    aliases: ['magic crew', 'the drafters'],
    members: [
      { id: REMI, since: '2021', role: 'organizer' },
      { id: DALE, since: '2021-06', until: '2023-02' },
      { id: NOVA, since: 2024 },
    ],
    ...over,
  });

  it('accepts a circle with dated membership, aliases and roles', () => {
    expect(validateCircleDraft(circle())).toEqual({
      ok: true,
      value: {
        slug: 'mtg',
        title: 'The MTG crew',
        content: '## Now\nFriday drafts at the game store.',
        aliases: ['magic crew', 'the drafters'],
        members: [
          { id: REMI, since: '2021', until: null, role: 'organizer' },
          { id: DALE, since: '2021-06', until: '2023-02', role: null },
          { id: NOVA, since: '2024', until: null, role: null },
        ],
        merged_from: [],
      },
    });
  });

  it("lets the members' own ids appear in the text, nobody else's", () => {
    expect(validateCircleDraft(circle({ content: `Remi (${REMI}) runs it.` })).ok).toBe(true);
    expect(validateCircleDraft(circle({ content: `Friend of 100000000000000009.` })).ok).toBe(false);
  });

  it('refuses a pair of one, bad ids, bad dates, leaving before joining and duplicates', () => {
    const errorsOf = (over: Record<string, unknown>) => {
      const result = validateCircleDraft(circle(over));
      return result.ok ? [] : result.errors;
    };
    expect(errorsOf({ members: [{ id: REMI }] })).toEqual(['circle "mtg": a circle has at least 2 members']);
    expect(errorsOf({ members: [{ id: 'remi' }, { id: DALE }] })[0]).toContain('a member id must be a Discord id');
    expect(errorsOf({ members: [{ id: REMI, since: 'last year' }, { id: DALE }] })[0]).toContain('YYYY, YYYY-MM');
    expect(errorsOf({ members: [{ id: REMI, since: '2024-05', until: '2023' }, { id: DALE }] })[0]).toContain(
      'leaves (2023) before joining (2024-05)',
    );
    // Same year at different precision is fine.
    expect(errorsOf({ members: [{ id: REMI, since: '2023-05', until: '2023' }, { id: DALE }] })).toEqual([]);
    expect(errorsOf({ members: [{ id: REMI }, { id: REMI }, { id: DALE }] })[0]).toContain('listed twice');
    expect(errorsOf({ aliases: ['<@100000000000000001>'] })[0]).toContain('an alias must be plain');
    expect(errorsOf({ merged_from: ['mtg'] })).toEqual(['circle "mtg": a circle can\'t be merged into itself']);
    expect(errorsOf({ content: 'x'.repeat(NOTE_LIMITS.circleMaxChars + 1) })[0]).toContain('over the 6000 limit');
  });
});

describe('validateNotesOutput with circles', () => {
  const pair = {
    slug: 'remi-and-dale',
    title: 'Remi & Dale',
    content: 'Best friends since school.',
    members: [{ id: REMI }, { id: DALE }],
  };

  it('reads circles and removed circles, and defaults them to []', () => {
    const result = validateNotesOutput(
      { notes: [], circles: [pair], removed_circles: ['old-pair'], change_summary: 'pair' },
      { scope: 'person' },
    );
    expect(result.ok && [result.value.circles.map((c) => c.slug), result.value.removed_circles]).toEqual([
      ['remi-and-dale'],
      ['old-pair'],
    ]);
    const bare = validateNotesOutput({ notes: [], change_summary: '' }, { scope: 'group' });
    expect(bare.ok && [bare.value.circles, bare.value.removed_circles]).toEqual([[], []]);
  });

  it('refuses a circle written twice, written and removed, or written and merged', () => {
    const errorsOf = (raw: unknown) => {
      const result = validateNotesOutput(raw, { scope: 'group' });
      return result.ok ? [] : result.errors;
    };
    expect(errorsOf({ notes: [], circles: [pair, pair] })).toEqual(['circle "remi-and-dale" appears twice']);
    expect(errorsOf({ notes: [], circles: [pair], removed_circles: ['remi-and-dale'] })).toEqual([
      'circle "remi-and-dale" is both written and removed',
    ]);
    expect(
      errorsOf({ notes: [], circles: [pair, { ...pair, slug: 'dale-and-remi', merged_from: ['remi-and-dale'] }] }),
    ).toEqual(['circle "remi-and-dale" is both written and merged into "dale-and-remi"']);
  });

  it('keeps an edit of a circle to exactly that circle', () => {
    expect(validateNotesOutput({ circles: [pair], change_summary: 'x' }, { scope: 'circle' }).ok).toBe(true);
    expect(
      validateNotesOutput(
        { notes: [{ topic: 'lore', title: 'Lore', content: 'x' }], circles: [pair] },
        { scope: 'circle' },
      ).ok,
    ).toBe(false);
    expect(validateNotesOutput({ circles: [] }, { scope: 'circle' }).ok).toBe(false);
  });
});

describe('validateOccasionDraft', () => {
  const trip = (over: Record<string, unknown> = {}) => ({
    slug: 'ski-trip-2027',
    title: 'Ski trip',
    content: '## Plan\nA week at Tremblant; chalet booked, lift passes still open.',
    starts_on: '2027-01-10',
    ends_on: '2027-01-17',
    place: 'Tremblant',
    status: 'planned',
    participants: [
      { id: REMI, role: 'organizer' },
      { id: DALE, until: '2026-12', role: 'bailed' },
      { id: NOVA, role: 'maybe' },
    ],
    ...over,
  });
  const errorsOf = (over: Record<string, unknown>) => {
    const result = validateOccasionDraft(trip(over));
    return result.ok ? [] : result.errors;
  };

  it('accepts an occasion with dates, place, status and dated participants', () => {
    const result = validateOccasionDraft(trip({ aliases: ['the ski trip'] }));
    expect(result.ok && result.value).toEqual({
      slug: 'ski-trip-2027',
      title: 'Ski trip',
      content: '## Plan\nA week at Tremblant; chalet booked, lift passes still open.',
      aliases: ['the ski trip'],
      starts_on: '2027-01-10',
      ends_on: '2027-01-17',
      place: 'Tremblant',
      status: 'planned',
      participants: [
        { id: REMI, since: null, until: null, role: 'organizer' },
        { id: DALE, since: null, until: '2026-12', role: 'bailed' },
        { id: NOVA, since: null, until: null, role: 'maybe' },
      ],
      circle: null,
    });
    // A round of a tradition names its circle by slug.
    const round = validateOccasionDraft(trip({ circle: 'Winter-Dinners' }));
    expect(round.ok && round.value.circle).toBe('winter-dinners');
    expect(errorsOf({ circle: 'the winter dinners' })[0]).toContain('"circle" must be a circle\'s slug');
  });

  it('reads an absent status and place as none, partial dates, and "members" when "participants" is missing', () => {
    const { participants, ...rest } = trip({ status: undefined, place: undefined, starts_on: '2027-01', ends_on: null });
    const result = validateOccasionDraft({ ...rest, members: participants });
    expect(result.ok && [result.value.status, result.value.place, result.value.starts_on, result.value.ends_on]).toEqual(
      [null, null, '2027-01', null],
    );
    expect(validateOccasionDraft(trip({ status: 'PAST' })).ok).toBe(true);
  });

  it('refuses missing or bad dates, an end before the start, an unknown status and a bad place', () => {
    expect(errorsOf({ starts_on: undefined })).toEqual([
      'occasion "ski-trip-2027": "starts_on" is required (YYYY, YYYY-MM or YYYY-MM-DD)',
    ]);
    expect(errorsOf({ starts_on: 'next January' })[0]).toContain('"starts_on" must be YYYY');
    expect(errorsOf({ ends_on: '2027-01-02' })).toEqual([
      'occasion "ski-trip-2027": it ends (2027-01-02) before it starts (2027-01-10)',
    ]);
    expect(errorsOf({ status: 'postponed' })[0]).toContain('"status" must be one of planned, happening, past');
    expect(errorsOf({ place: 'a\nb' })[0]).toContain('"place" must be plain one-line text');
    expect(errorsOf({ place: 'x'.repeat(NOTE_LIMITS.placeMaxChars + 1) })[0]).toContain('"place" must be plain');
  });

  it('holds participants, size and markup to the same rules as circles', () => {
    expect(errorsOf({ participants: [{ id: REMI }] })).toEqual([
      'occasion "ski-trip-2027": an occasion has at least 2 participants',
    ]);
    expect(errorsOf({ participants: [{ id: REMI }, { id: REMI }] })[0]).toContain('participant');
    expect(errorsOf({ content: 'x'.repeat(NOTE_LIMITS.occasionMaxChars + 1) })[0]).toContain('over the 4000 limit');
    expect(errorsOf({ content: 'flying with <@100000000000000009>' })[0]).toContain('a Discord mention');
    // A participant's own id may appear in the text, nobody else's.
    expect(errorsOf({ content: `organized by ${REMI}` })).toEqual([]);
    expect(errorsOf({ content: 'organized by 100000000000000009' })[0]).toContain("wasn't in the input");
  });
});

describe('validateNotesOutput with occasions and archived circles', () => {
  const pair = {
    slug: 'remi-and-dale',
    title: 'Remi & Dale',
    content: 'Best friends since school.',
    members: [{ id: REMI }, { id: DALE }],
  };
  const trip = {
    slug: 'orchard-trip',
    title: 'Orchard trip',
    content: '## Plan\nSaturday at the orchard.',
    starts_on: '2026-10-17',
    participants: [{ id: REMI }, { id: NOVA }],
  };
  const errorsOf = (raw: unknown, scope: 'person' | 'group' | 'circle' | 'occasion' = 'person') => {
    const result = validateNotesOutput(raw, { scope });
    return result.ok ? [] : result.errors;
  };

  it('reads occasions, removed occasions and archived circles, and defaults them to []', () => {
    const result = validateNotesOutput(
      { notes: [], occasions: [trip], removed_occasions: ['old-trip'], archived_circles: ['yugioh'] },
      { scope: 'person' },
    );
    expect(
      result.ok && [
        result.value.occasions.map((o) => o.slug),
        result.value.removed_occasions,
        result.value.archived_circles,
      ],
    ).toEqual([['orchard-trip'], ['old-trip'], ['yugioh']]);
    const bare = validateNotesOutput({ notes: [] }, { scope: 'group' });
    expect(bare.ok && [bare.value.occasions, bare.value.removed_occasions, bare.value.archived_circles]).toEqual([
      [],
      [],
      [],
    ]);
  });

  it('refuses an occasion twice or written and removed, and a circle both archived and removed or merged away', () => {
    expect(errorsOf({ notes: [], occasions: [trip, trip] })).toEqual(['occasion "orchard-trip" appears twice']);
    expect(errorsOf({ notes: [], occasions: [trip], removed_occasions: ['orchard-trip'] })).toEqual([
      'occasion "orchard-trip" is both written and removed',
    ]);
    expect(errorsOf({ notes: [], removed_circles: ['yugioh'], archived_circles: ['yugioh'] })).toEqual([
      'circle "yugioh" is both removed and archived',
    ]);
    expect(errorsOf({ notes: [], circles: [{ ...pair, merged_from: ['yugioh'] }], archived_circles: ['yugioh'] })).toEqual(
      ['circle "yugioh" is both merged away and archived'],
    );
    // Written and archived: saved with that text, archived.
    expect(errorsOf({ notes: [], circles: [pair], archived_circles: ['remi-and-dale'] })).toEqual([]);
  });

  it('keeps an edit of an occasion to exactly that occasion', () => {
    expect(errorsOf({ occasions: [trip], change_summary: 'x' }, 'occasion')).toEqual([]);
    expect(errorsOf({ occasions: [] }, 'occasion')).toContain('an occasion is written exactly: one entry in "occasions"');
    expect(errorsOf({ occasions: [trip], circles: [pair] }, 'occasion')).toContain(
      'an occasion is written alone: no circles, no removals',
    );
    expect(
      errorsOf({ notes: [{ topic: 'lore', title: 'Lore', content: 'x' }], occasions: [trip] }, 'occasion'),
    ).toContain('an occasion is written in "occasions" only');
  });

  it('lets an edit of a circle archive it as it is, but write nothing else', () => {
    expect(errorsOf({ archived_circles: ['remi-and-dale'] }, 'circle')).toEqual([]);
    expect(errorsOf({ circles: [pair], archived_circles: ['remi-and-dale'] }, 'circle')).toEqual([]);
    expect(errorsOf({ circles: [pair], archived_circles: ['yugioh'] }, 'circle')).toEqual([
      'an edit of a circle archives no other circle',
    ]);
    expect(errorsOf({ archived_circles: ['a', 'b'] }, 'circle')).toEqual([
      'an edit of a circle writes exactly that circle',
    ]);
    expect(errorsOf({ circles: [pair], occasions: [trip] }, 'circle')).toEqual([
      'an edit of a circle writes no occasions',
    ]);
  });
});
