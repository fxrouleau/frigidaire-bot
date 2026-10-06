import { describe, expect, it } from 'vitest';
import {
  type ActivityMonth,
  addDays,
  analyzeActivity,
  byOccasionRelevance,
  CIRCLE_DECAY,
  circlePresence,
  circleStability,
  daysBetween,
  defaultOccasionStatus,
  describePhase,
  describeRevivals,
  easternToday,
  LIFECYCLE_PER_NIGHT,
  lastMemberLeft,
  OCCASION_LIFECYCLE,
  occasionEndDay,
  occasionPhase,
  partialDateEnd,
  partialDateStart,
  phaseByDates,
  planLifecycle,
  UNDO_KEEPS_DAYS,
  yearlyCadence,
} from './lifecycle';
import type { Note } from './notesStore';
import { NOTE_LIMITS } from './schema';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const DALE = '100000000000000002';

let nextId = 1;

function note(over: Partial<Note> = {}): Note {
  return {
    id: nextId++,
    scope: 'occasion',
    ownerId: null,
    topic: 'ski-trip-2027',
    title: 'Ski trip',
    content: '## Plan\nA week at Tremblant.',
    aliases: [],
    members: [
      { memberId: REMI, since: null, until: null, role: 'organizer' },
      { memberId: DALE, since: null, until: null, role: null },
    ],
    version: 1,
    updatedAt: '2026-10-01 12:00:00',
    updatedBy: 'dream',
    active: true,
    status: 'planned',
    startsOn: '2027-01-10',
    endsOn: '2027-01-17',
    place: 'Tremblant',
    circle: null,
    ...over,
  };
}

/** Monthly activity from `from` to `to` (YYYY-MM, both included), each month `weight`. */
function monthly(from: string, to: string, weight = 5): ActivityMonth[] {
  const months: ActivityMonth[] = [];
  let [year, month] = from.split('-').map(Number);
  while (`${year}-${String(month).padStart(2, '0')}` <= to) {
    months.push({ month: `${year}-${String(month).padStart(2, '0')}`, weight });
    month = month === 12 ? 1 : month + 1;
    if (month === 1) year++;
  }
  return months;
}

const LIVE_MEMBERS = [
  { memberId: REMI, since: '2018', until: null, role: null },
  { memberId: DALE, since: '2018', until: null, role: null },
];

function circle(over: Partial<Note> = {}): Note {
  return note({
    scope: 'circle',
    topic: 'yugioh',
    title: 'The Yu-Gi-Oh crew',
    content: '## Now\nNobody plays any more.',
    status: null,
    startsOn: null,
    endsOn: null,
    place: null,
    members: [
      { memberId: REMI, since: '2018', until: '2020', role: null },
      { memberId: DALE, since: '2018', until: '2021-03', role: null },
    ],
    ...over,
  });
}

describe('dates', () => {
  it('reads partial dates as the days they cover', () => {
    expect(partialDateStart('2027')).toBe('2027-01-01');
    expect(partialDateStart('2027-02')).toBe('2027-02-01');
    expect(partialDateEnd('2027')).toBe('2027-12-31');
    expect(partialDateEnd('2028-02')).toBe('2028-02-29');
    expect(partialDateEnd('2027-02')).toBe('2027-02-28');
    expect(partialDateEnd('2027-01-17')).toBe('2027-01-17');
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3);
    expect(daysBetween('2027-01-02', '2026-12-30')).toBe(-3);
    expect(addDays('2027-01-01', -3)).toBe('2026-12-29');
  });

  it('takes today from the Eastern clock, not UTC', () => {
    // 03:30 UTC on the 11th is still the 10th in New York (EST, UTC−5).
    expect(easternToday(new Date('2027-01-11T03:30:00Z'))).toBe('2027-01-10');
    expect(easternToday(new Date('2027-01-11T05:30:00Z'))).toBe('2027-01-11');
  });
});

describe('phases', () => {
  it('derives planned, happening and past from the dates at their precision', () => {
    expect(phaseByDates('2027-01-10', '2027-01-17', '2027-01-09')).toBe('planned');
    expect(phaseByDates('2027-01-10', '2027-01-17', '2027-01-10')).toBe('happening');
    expect(phaseByDates('2027-01-10', '2027-01-17', '2027-01-17')).toBe('happening');
    expect(phaseByDates('2027-01-10', '2027-01-17', '2027-01-18')).toBe('past');
    // A one-day outing is happening on its day; a month-only trip all month.
    expect(phaseByDates('2026-10-17', null, '2026-10-17')).toBe('happening');
    expect(phaseByDates('2027-01', null, '2026-12-31')).toBe('planned');
    expect(phaseByDates('2027-01', null, '2027-01-25')).toBe('happening');
    expect(phaseByDates('2027-01', null, '2027-02-01')).toBe('past');
  });

  it('flips at the Eastern day boundary', () => {
    const trip = note({ startsOn: '2027-01-10', endsOn: '2027-01-17' });
    // 04:59 UTC on the 18th is 23:59 on the 17th in New York: still happening.
    expect(occasionPhase(trip, easternToday(new Date('2027-01-18T04:59:00Z')))).toBe('happening');
    expect(occasionPhase(trip, easternToday(new Date('2027-01-18T05:00:00Z')))).toBe('past');
  });

  it('keeps a stored cancelled, archived or past status whatever the dates say', () => {
    expect(occasionPhase(note({ status: 'cancelled' }), '2026-10-06')).toBe('cancelled');
    expect(occasionPhase(note({ status: 'archived' }), '2026-10-06')).toBe('archived');
    expect(occasionPhase(note({ status: 'past' }), '2026-10-06')).toBe('past');
    expect(occasionPhase(note({ status: 'happening' }), '2026-10-06')).toBe('planned');
  });

  it('says where an occasion is in words', () => {
    expect(describePhase(note(), '2027-01-01')).toBe('planned, starts in 9 days');
    expect(describePhase(note(), '2027-01-09')).toBe('planned, starts tomorrow');
    expect(describePhase(note(), '2027-01-12')).toBe('happening now');
    expect(describePhase(note(), '2027-01-20')).toBe('past, ended 3 days ago');
    expect(describePhase(note({ status: 'cancelled' }), '2027-01-20')).toBe('cancelled');
  });

  it('gives a new occasion without a status planned, or past when its dates are behind', () => {
    expect(defaultOccasionStatus('2027-01-10', null, '2026-10-06')).toBe('planned');
    expect(defaultOccasionStatus('2026-09-01', '2026-09-03', '2026-10-06')).toBe('past');
    expect(occasionEndDay(note({ endsOn: null, startsOn: '2027-01' }))).toBe('2027-01-31');
  });

  it('sorts happening first, then the soonest planned, then the most recent past, archived last', () => {
    const today = '2026-10-06';
    const archived = note({ topic: 'old', status: 'archived', startsOn: '2025-01-01', endsOn: null });
    const past = note({ topic: 'past', status: 'past', startsOn: '2026-09-01', endsOn: null });
    const later = note({ topic: 'later', startsOn: '2027-03-01', endsOn: null });
    const soon = note({ topic: 'soon', startsOn: '2026-10-20', endsOn: null });
    const now = note({ topic: 'now', startsOn: '2026-10-05', endsOn: '2026-10-08' });
    expect([archived, past, later, soon, now].sort(byOccasionRelevance(today)).map((o) => o.topic)).toEqual([
      'now',
      'soon',
      'later',
      'past',
      'old',
    ]);
  });
});

describe('planLifecycle', () => {
  const today = '2027-01-25';

  it('rewrites an occasion as history once it ended historyGraceDays ago, never before', () => {
    const ended = (end: string) => note({ startsOn: '2027-01-10', endsOn: end });
    expect(planLifecycle({ occasions: [ended('2027-01-24')], circles: [], today }).history).toEqual([]);
    const due = ended(addDays(today, -OCCASION_LIFECYCLE.historyGraceDays));
    expect(planLifecycle({ occasions: [due], circles: [], today }).history).toEqual([due]);
    // Already written as history, or cancelled: nothing to rewrite.
    expect(planLifecycle({ occasions: [note({ status: 'past', endsOn: '2027-01-17' })], circles: [], today }).history)
      .toEqual([]);
  });

  it('archives a past occasion archiveAfterDays after it ended and a cancelled one cancelledArchiveAfterDays after its last write', () => {
    const end = addDays(today, -OCCASION_LIFECYCLE.archiveAfterDays);
    const longPast = note({ status: 'past', startsOn: addDays(end, -7), endsOn: end });
    const recent = note({ status: 'past', startsOn: '2027-01-01', endsOn: addDays(end, 1) });
    // Never written as history and long over: archived directly (the archive call reads its journal).
    const neverRewritten = note({ status: 'planned', startsOn: '2026-01-01', endsOn: '2026-01-05' });
    const cancelled = note({ status: 'cancelled', updatedAt: '2027-01-10 15:00:00' });
    const cancelledRecently = note({ status: 'cancelled', updatedAt: '2027-01-20 15:00:00' });
    const plan = planLifecycle({
      occasions: [longPast, recent, neverRewritten, cancelled, cancelledRecently],
      circles: [],
      today,
    });
    // The longest over first.
    expect(plan.archive.map((t) => [t.note.id, t.why])).toEqual([
      [neverRewritten.id, 'ended'],
      [longPast.id, 'ended'],
      [cancelled.id, 'cancelled'],
    ]);
    expect(plan.history).toEqual([]);
  });

  it('leaves a note the owner just undid alone for UNDO_KEEPS_DAYS: no archive, no history, no compaction', () => {
    const end = addDays(today, -OCCASION_LIFECYCLE.archiveAfterDays - 30);
    const undoneAt = (day: string) => `${day} 15:00:00`;
    const undoneArchive = note({ status: 'past', startsOn: addDays(end, -3), endsOn: end, updatedBy: 'undo', updatedAt: undoneAt(addDays(today, -1)) });
    const undoneHistory = note({ status: 'planned', startsOn: '2027-01-10', endsOn: '2027-01-17', updatedBy: 'undo', updatedAt: undoneAt(addDays(today, -1)) });
    const long = 'x'.repeat(NOTE_LIMITS.archivedMaxChars + 1);
    const undoneCompaction = circle({ status: 'archived', content: long, updatedBy: 'undo', updatedAt: undoneAt(addDays(today, -2)) });
    const undoneDormant = circle({
      topic: 'chess',
      members: LIVE_MEMBERS,
      updatedBy: 'undo',
      updatedAt: undoneAt(addDays(today, -3)),
    });
    const activity = new Map<number, ActivityMonth[]>([[undoneDormant.id, monthly('2024-01', '2024-02')]]);
    const kept = planLifecycle({
      occasions: [undoneArchive, undoneHistory],
      circles: [undoneCompaction, undoneDormant],
      today,
      activity,
    });
    expect(kept.archive).toEqual([]);
    expect(kept.history).toEqual([]);
    // Still said to be fading: it is kept, not forgotten.
    expect(kept.fading).toEqual([undoneDormant]);
    // UNDO_KEEPS_DAYS later, the lifecycle takes them up again.
    const later = addDays(today, UNDO_KEEPS_DAYS);
    const plan = planLifecycle({
      occasions: [undoneArchive],
      circles: [undoneCompaction, undoneDormant],
      today: later,
      activity,
    });
    expect(plan.archive.map((t) => t.why)).toEqual(['ended', 'compact', 'dormant']);
  });

  it('puts the notes whose last step failed on the answer after the untried ones', () => {
    const old = (topic: string, until: string) =>
      circle({
        topic,
        members: [
          { memberId: REMI, since: '2010', until, role: null },
          { memberId: DALE, since: '2010', until, role: null },
        ],
      });
    const stubborn = old('stubborn', '2015');
    const fresh = old('fresh', '2019');
    const failedHistory = note({ startsOn: '2027-01-01', endsOn: '2027-01-05' });
    const freshHistory = note({ startsOn: '2027-01-10', endsOn: '2027-01-12' });
    const plan = planLifecycle({
      occasions: [failedHistory, freshHistory],
      circles: [stubborn, fresh],
      today,
      failed: new Set([stubborn.id, failedHistory.id]),
    });
    expect(plan.archive.map((t) => t.note.topic)).toEqual(['fresh', 'stubborn']);
    expect(plan.history).toEqual([freshHistory, failedHistory]);
  });

  it('without activity, archives a circle once everyone left and the last of them left long ago', () => {
    const lastLeft = addDays(today, -CIRCLE_DECAY.fallbackArchiveAfterDays);
    const dormant = circle({
      members: [
        { memberId: REMI, since: '2018', until: '2020', role: null },
        { memberId: DALE, since: '2018', until: lastLeft, role: null },
      ],
    });
    const notYet = circle({
      topic: 'tarkov',
      members: [
        { memberId: REMI, since: '2022', until: '2023', role: null },
        { memberId: DALE, since: '2022', until: addDays(lastLeft, 1), role: null },
      ],
    });
    // Someone still in it (an "until" the import left bent): present by membership; its activity decides.
    const stillCurrent = circle({
      topic: 'dbfz',
      members: [
        { memberId: REMI, since: '2018', until: '2019', role: null },
        { memberId: DALE, since: '2018', until: null, role: null },
      ],
    });
    expect(lastMemberLeft(dormant)).toBe(lastLeft);
    expect(lastMemberLeft(stillCurrent)).toBeUndefined();
    const plan = planLifecycle({ occasions: [], circles: [dormant, notYet, stillCurrent], today });
    expect(plan.archive).toEqual([{ note: dormant, why: 'dormant' }]);
  });

  it('archives circles that faded out by their activity, the faintest first, and lists the fading ones', () => {
    const faded = circle({ topic: 'dbfz', members: LIVE_MEMBERS });
    const fainter = circle({ topic: 'chess', members: LIVE_MEMBERS });
    const fading = circle({ topic: 'tarkov', members: LIVE_MEMBERS });
    const present = circle({ topic: 'mtg', members: LIVE_MEMBERS });
    const activity = new Map<number, ActivityMonth[]>([
      [faded.id, monthly('2026-07', '2026-08')],
      [fainter.id, monthly('2025-01', '2025-02')],
      [fading.id, monthly('2026-10', '2026-11')],
      [present.id, monthly('2024-01', '2027-01')],
    ]);
    const plan = planLifecycle({ occasions: [], circles: [faded, fainter, fading, present], today, activity });
    expect(plan.archive.map((t) => [t.note.topic, t.why])).toEqual([
      ['chess', 'dormant'],
      ['dbfz', 'dormant'],
    ]);
    expect(plan.fading.map((c) => c.topic)).toEqual(['tarkov']);
  });

  it('compacts archived notes still longer than a trace, never one the owner last edited', () => {
    const long = 'x'.repeat(NOTE_LIMITS.archivedMaxChars + 1);
    const writerArchived = circle({ status: 'archived', content: long });
    const ownerEdited = circle({ topic: 'owned', status: 'archived', content: long, updatedBy: 'edit' });
    const short = circle({ topic: 'short', status: 'archived', content: 'A trace.' });
    const plan = planLifecycle({ occasions: [], circles: [writerArchived, ownerEdited, short], today });
    expect(plan.archive).toEqual([{ note: writerArchived, why: 'compact' }]);
  });

  it('caps the night, the oldest first, and counts what waits', () => {
    const circles = Array.from({ length: LIFECYCLE_PER_NIGHT.archive + 3 }, (_, i) =>
      circle({
        topic: `old-${i}`,
        members: [
          { memberId: REMI, since: '2010', until: `${2019 - (i % 5)}-0${1 + (i % 9)}`, role: null },
          { memberId: DALE, since: '2010', until: '2012', role: null },
        ],
      }),
    );
    const plan = planLifecycle({ occasions: [], circles, today });
    expect(plan.archive).toHaveLength(LIFECYCLE_PER_NIGHT.archive);
    expect(plan.deferred).toBe(3);
    const keys = plan.archive.map((t) => lastMemberLeft(t.note) ?? '');
    expect([...keys].sort()).toEqual(keys);
  });

  it('ignores inactive notes and live circles', () => {
    const removed = note({ active: false, status: 'past', endsOn: '2025-01-01', startsOn: '2025-01-01' });
    const live = circle({
      topic: 'live',
      members: [
        { memberId: REMI, since: '2024', until: null, role: null },
        { memberId: DALE, since: '2024', until: null, role: null },
      ],
    });
    expect(planLifecycle({ occasions: [removed], circles: [live], today })).toEqual({
      history: [],
      archive: [],
      deferred: 0,
      fading: [],
    });
  });
});

describe('circle decay (spaced repetition)', () => {
  const presence = (series: ActivityMonth[], today: string) => circlePresence({ members: LIVE_MEMBERS }, series, today);

  it('fades a one-month burst within a month and archives it about two months after', () => {
    const burst = [{ month: '2026-03', weight: 30 }];
    expect(circleStability(burst)).toBe(CIRCLE_DECAY.initialStabilityDays);
    expect(presence(burst, '2026-04-10').state).toBe('present');
    expect(presence(burst, '2026-04-25').state).toBe('fading');
    expect(presence(burst, '2026-05-25').state).toBe('fading');
    expect(presence(burst, '2026-06-01').state).toBe('archive');
  });

  it('keeps something used monthly for three years through a year off', () => {
    const years = monthly('2021-01', '2023-12');
    // Every gap between real months adds its length: sustained use grows it to about its span.
    expect(circleStability(years)).toBe(30 + daysBetween('2021-01-01', '2023-12-01'));
    const yearOff = presence(years, '2024-12-31');
    expect(yearOff.state).toBe('present');
    expect(yearOff.r).toBeCloseTo(Math.exp(-366 / 1094), 3);
    expect(presence(years, '2026-06-01').state).toBe('fading');
    expect(presence(years, '2029-10-01').state).toBe('archive');
  });

  it('ranks sustained monthly use above a shorter, sparser run', () => {
    const monthlyFor36 = monthly('2021-01', '2023-12', 3);
    const everyOtherMonthFor18 = monthly('2021-01', '2022-06', 3).filter((_, i) => i % 2 === 0);
    expect(circleStability(monthlyFor36)).toBeGreaterThan(circleStability(everyOtherMonthFor18) as number);
    // Quarterly meetings of small weight confirm each other (within three calendar months, any year length).
    const quarterly = ['2023-01', '2023-04', '2023-07', '2023-10', '2024-01'].map((month) => ({ month, weight: 3 }));
    expect(analyzeActivity(quarterly)).toMatchObject({ lastReal: '2024-01', stabilityDays: 30 + 365 });
    expect(analyzeActivity(quarterly)).not.toHaveProperty('lastBlip');
  });

  it('keeps a yearly tradition alive between rounds and through a skipped year', () => {
    const twice = [
      { month: '2024-02', weight: 12 },
      { month: '2025-02', weight: 12 },
    ];
    expect(circleStability(twice)).toBe(30 + 366);
    const aYearLater = presence(twice, '2026-02-28');
    expect(aYearLater.state).toBe('fading');
    expect(aYearLater.r).toBeCloseTo(0.4, 1);
    // The round after a skipped year is still remembered.
    expect(presence(twice, '2027-02-01').state).toBe('fading');
    expect(presence(twice, '2027-04-15').state).toBe('archive');
    // A third round makes it present all year.
    const thrice = [...twice, { month: '2026-02', weight: 12 }];
    expect(presence(thrice, '2027-01-31').state).toBe('present');
    expect(yearlyCadence(twice)?.label).toBe('yearly (Feb)');
    expect(yearlyCadence(thrice)?.label).toBe('yearly (usually Feb)');
    // Rounds too small to be real make no rhythm: the second is a blip.
    const small = twice.map((m) => ({ ...m, weight: 2 }));
    expect(yearlyCadence(small)).toBeUndefined();
    expect(circleStability(small)).toBe(30 + 7);
    // Once the rhythm is there (two real seasons before), a small round in it is real.
    const kept = [...twice, { month: '2026-02', weight: 2 }];
    expect(analyzeActivity(kept)).toMatchObject({ lastReal: '2026-02', stabilityDays: 30 + 366 + 365 });
  });

  it('never reads a yearly rhythm into a burst and one stray mention years later', () => {
    const series = [
      { month: '2019-03', weight: 20 },
      { month: '2019-04', weight: 20 },
      { month: '2024-03', weight: 1 },
    ];
    expect(yearlyCadence(series)).toBeUndefined();
    expect(analyzeActivity(series)).toMatchObject({ lastReal: '2019-04', lastBlip: '2024-03', stabilityDays: 30 + 31 + 7 });
    expect(presence(series, '2024-04-15').state).toBe('fading');
    expect(presence(series, '2024-08-01').state).toBe('archive');
  });

  it('treats a lone blip years later as a small sighting: provisional, gone again within about four months', () => {
    const series = [...monthly('2019-01', '2019-06'), { month: '2025-03', weight: 2, revival: true }];
    const analysis = analyzeActivity(series);
    expect(analysis).toMatchObject({
      stabilityDays: 30 + daysBetween('2019-01-01', '2019-06-01') + 7,
      lastReal: '2019-06',
      lastBlip: '2025-03',
    });
    const soon = presence(series, '2025-04-15');
    expect(soon).toMatchObject({ state: 'fading', provisional: true });
    expect(presence(series, '2025-07-15').state).toBe('fading');
    expect(presence(series, '2025-08-01').state).toBe('archive');
    expect(describeRevivals(analysis, '2025-04-15')).toEqual(['back since Mar 2025, provisionally']);
    expect(describeRevivals(analysis, '2025-08-01')).toEqual(['brief revival Mar 2025']);
  });

  it('strengthens a confirmed comeback after two years by the whole gap', () => {
    const before = monthly('2022-07', '2022-12');
    const base = circleStability(before) as number;
    const confirmed = [...before, { month: '2025-01', weight: 3, revival: true }, { month: '2025-02', weight: 3 }];
    const gap = daysBetween('2022-12-01', '2025-01-01');
    expect(circleStability(confirmed)).toBe(base + gap + 31);
    expect(presence(confirmed, '2025-03-15').state).toBe('present');
    expect(describeRevivals(analyzeActivity(confirmed), '2025-03-15')).toEqual(['revived Jan 2025']);
    // A substantial month is a real return on its own.
    const substantial = [...before, { month: '2025-01', weight: CIRCLE_DECAY.realReturnWeight }];
    expect(circleStability(substantial)).toBe(base + gap);
    expect(presence(substantial, '2025-02-10').state).toBe('present');
    // Not confirmed in time: a blip, the old stability kept.
    const late = [...before, { month: '2025-01', weight: 3 }, { month: '2025-06', weight: 3 }];
    expect(circleStability(late)).toBe(base + 7 + 7);
  });

  it('caps stability and falls back to membership without activity', () => {
    const decade = Array.from({ length: 10 }, (_, i) => ({ month: `${2015 + i}-06`, weight: 20 }));
    expect(circleStability(decade)).toBe(CIRCLE_DECAY.maxStabilityDays);
    expect(circlePresence({ members: LIVE_MEMBERS }, [], '2027-01-01')).toEqual({ state: 'present', basis: 'membership' });
  });
});

describe('yearlyCadence', () => {
  it('finds a yearly window, December–January wrapping', () => {
    expect(
      yearlyCadence([
        { month: '2023-02', weight: 12 },
        { month: '2024-02', weight: 12 },
        { month: '2025-03', weight: 12 },
      ]),
    ).toMatchObject({ kind: 'yearly', seasons: 3, label: 'yearly (usually Feb–Mar)' });
    expect(
      yearlyCadence([
        { month: '2023-12', weight: 12 },
        { month: '2025-01', weight: 12 },
        { month: '2025-12', weight: 12 },
      ])?.label,
    ).toBe('yearly (usually Dec–Jan)');
  });

  it('weighs the window by activity, so small chatter in other months does not hide the season', () => {
    const season = (year: number) => [
      { month: `${year}-03`, weight: 8 },
      { month: `${year}-04`, weight: 8 },
      { month: `${year}-11`, weight: 2 },
      { month: `${year}-12`, weight: 2 },
    ];
    expect(yearlyCadence([...season(2022), ...season(2023), ...season(2024)])?.label).toBe('yearly (usually Mar–Apr)');
  });

  it('finds none for something busy all year, or seen in one season only', () => {
    expect(yearlyCadence(monthly('2022-01', '2024-12'))).toBeUndefined();
    expect(yearlyCadence([{ month: '2024-02', weight: 1 }, { month: '2024-03', weight: 1 }])).toBeUndefined();
  });
});
