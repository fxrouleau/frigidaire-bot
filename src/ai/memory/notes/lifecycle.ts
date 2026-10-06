// The lifecycle of shared notes (docs/memory.md "Occasions, decay and archiving"): occasions are planned,
// happen, become history and are archived; circles fade by use and are archived once they faded out.
// Archived notes stay readable and searchable as a short historical trace, but leave the dreams' inputs (one
// line each) and the chat context. Pure functions over already-loaded notes and Eastern calendar days (YYYY-MM-DD): the store
// derives an occasion's phase with them, the nightly lifecycle pass (dreamer.ts runLifecycle) plans its
// work with planLifecycle(), and the chat turn picks occasions with them.
//
// The owner's words: "It's like a group that expires, but expires gracefully and not fully." The details
// matter before an occasion; afterwards it is history, and what happened during it can stay a core memory.
import { formatTimestampET, parseSqliteUtc } from '../../utils';
import type { Note } from './notesStore';
import { ARCHIVED_STATUS, NOTE_LIMITS, normalizeTopic, type OccasionStatus } from './schema';

/** When an occasion moves on (days are Eastern calendar days). */
export const OCCASION_LIFECYCLE = {
  /**
   * An occasion that is over by its dates and was never written as history gets the occasion pass this many
   * days after it ended: the stories told on the way back are in the journal by then.
   */
  historyGraceDays: 2,
  /** The journal rows the occasion pass reads: from this many days before it started… */
  journalDaysBefore: 3,
  /** …to this many days after it ended (plus rows that name it, from further around). */
  journalDaysAfter: 7,
  /** A past occasion is archived this many days after it ended. */
  archiveAfterDays: 90,
  /** A cancelled one this many days after it was cancelled (its last write). */
  cancelledArchiveAfterDays: 14,
  /** A chat turn shows a planned occasion starting within this many days (or one happening now). */
  upcomingDays: 60,
  /** Capture's "already known" keeps an occasion this many days after it ended (updates come in after). */
  recentlyPastDays: 14,
} as const;

/**
 * How a circle fades (the owner's call: "the more it's used, the longer it stays present; short bursts won't
 * last long, a long thing that keeps being re-used lasts longer, even with a break", and a yearly tradition
 * never expires). Like spaced repetition: each circle has a series of active months (note_activity: the
 * journal rows its dreams folded that name it, its linked occasions, a seed from the archive), a stability S
 * in days grown by that series, and a retrievability R = exp(−days since the end of its last real month / S):
 * - A month is REAL when it weighs at least realReturnWeight, or another weighed month lies within
 *   confirmMonths calendar months of it (sustained use, or a comeback confirmed), or it falls in the yearly
 *   rhythm of the months BEFORE it. The first month counts as real. Any other month is a blip: a passing
 *   mention years later.
 * - S starts at initialStabilityDays; every gap between two real months adds its full length (sustained use
 *   and re-use after a break both strengthen it: monthly use for three years and a quarterly meeting both
 *   end up near the cap); a blip adds only blipGainDays and doesn't move the clock. S is capped at
 *   maxStabilityDays.
 * - A blip still counts for a while: R is at least exp(−days since the blip / provisionalStabilityDays), but
 *   on a blip alone a circle is never more than fading. That is also how an archived circle comes back when
 *   new shared activity names it: provisionally, as fading; confirmed, the gap since its last real month is
 *   added and it is present again; unconfirmed, it is archived again about four months later (its old
 *   stability kept, so a later real comeback still benefits).
 * - Ambient activity (a row about two members that names no circle) only goes to circles that are present,
 *   at most ambientMonthCap a month: it is never a real month or a confirmation, only a blip-like sighting.
 * - present (R ≥ presentAt): a circle like any other; fading (archiveBelow ≤ R < presentAt): kept, but only
 *   brought into a chat turn when named, and only an excerpt in the dreams; below archiveBelow the nightly
 *   lifecycle pass archives it (a short historical trace).
 * Units: a seed counts archive messages; a dream credits dreamRowWeight per journal row that names the circle
 * (a row is a distilled observation, worth several messages); a linked occasion that happened weighs
 * realReturnWeight.
 * Examples (tested): a one-month burst fades within a month and is archived about two months after; monthly
 * for three years stays present through a year off (S at the cap); once a year, twice (S ≈ 396) is still
 * there a year later (R ≈ 0.40) and survives a skipped year (R ≈ 0.16).
 * A circle with no weighed month at all (before a seed) falls back to its membership: archived once nobody is
 * in it any more and the last member left fallbackArchiveAfterDays ago.
 */
export const CIRCLE_DECAY = {
  initialStabilityDays: 30,
  blipGainDays: 7,
  maxStabilityDays: 1_095,
  /** A month that weighs this much (archive messages, credited journal rows; a linked occasion) is real on its own. */
  realReturnWeight: 10,
  /** Another weighed month within this many calendar months makes a month real (sustained use, a confirmation). */
  confirmMonths: 3,
  /** How long a blip (an unconfirmed return, a provisional revival, ambient activity) keeps a circle around. */
  provisionalStabilityDays: 60,
  /** What one journal row that names a circle weighs when a dream credits it. */
  dreamRowWeight: 3,
  /** Ambient rows (shared, naming no circle) a present circle gets credited at most per month. */
  ambientMonthCap: 3,
  presentAt: 0.5,
  archiveBelow: 0.15,
  fallbackArchiveAfterDays: 180,
} as const;

/**
 * One month of a circle's activity (note_activity): `YYYY-MM`, how much happened (archive messages, credited
 * journal rows; a linked occasion weighs CIRCLE_DECAY.realReturnWeight), ambient sightings (rows about two
 * members that named no circle: never real), and whether the circle came back from the archive that month.
 */
export type ActivityMonth = { month: string; weight: number; ambient?: number; revival?: boolean };

/** What a circle's activity series says (analyzeActivity). */
export type ActivityAnalysis = {
  stabilityDays: number;
  /** The last month that counts: the first, regular use, or a real return. */
  lastReal: string;
  /** The newest blip after it (an unconfirmed return), if any. */
  lastBlip?: string;
  cadence?: Cadence;
  /** The months it came back from the archive: confirmed (a real return) or not (a brief revival). */
  revivals: { month: string; confirmed: boolean }[];
};

/** Where a circle is in its decay (see CIRCLE_DECAY). */
export type CirclePresence = {
  state: 'present' | 'fading' | 'archive';
  /** Retrievability, when the circle has activity. */
  r?: number;
  /** Stability in days, when the circle has activity. */
  stabilityDays?: number;
  /** The last month that counts, when the circle has activity. */
  lastActive?: string;
  /** Present only on a blip (an unconfirmed return or revival): held at fading until it is confirmed. */
  provisional?: boolean;
  /** What decided it: its activity series, or (none recorded yet) its membership. */
  basis: 'activity' | 'membership';
};

/**
 * The lifecycle pass's model calls per night: rewrites as history, and archivals (each compacts a note to
 * its trace with one small call). The rest wait for the following nights: the first night after deploy
 * finds every circle that has been over for years at once.
 */
export const LIFECYCLE_PER_NIGHT = { history: 10, archive: 10 } as const;

/**
 * An owner's undo sticks: a circle or occasion whose current version is an undo is left out of the lifecycle
 * pass (no archive, no history rewrite, no compaction) for this many days.
 */
export const UNDO_KEEPS_DAYS = 90;

/** Where an occasion is in its life: derived from its dates and today unless it is cancelled or archived. */
export type OccasionPhase = 'planned' | 'happening' | 'past' | 'cancelled' | 'archived';

/** The Eastern calendar day of an instant: `2026-10-06`. */
export function easternToday(now: Date): string {
  return formatTimestampET(now).slice(0, 10);
}

/** The Eastern day of a SQLite UTC timestamp, or undefined when it doesn't parse. */
export function easternDayOfTimestamp(sqliteUtc: string | null | undefined): string | undefined {
  const ms = parseSqliteUtc(sqliteUtc);
  return ms === undefined ? undefined : easternToday(new Date(ms));
}

const DAY_MS = 24 * 60 * 60_000;

function dayNumber(day: string): number {
  return Math.floor(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS);
}

/** Calendar days from `from` to `to` (YYYY-MM-DD each): negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** A day (YYYY-MM-DD) moved by `days`. */
export function addDays(day: string, days: number): string {
  return new Date((dayNumber(day) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** The first day a partial date covers: `2027` → `2027-01-01`, `2027-02` → `2027-02-01`. */
export function partialDateStart(date: string): string {
  if (date.length === 4) return `${date}-01-01`;
  if (date.length === 7) return `${date}-01`;
  return date.slice(0, 10);
}

/** The last day a partial date covers: `2027` → `2027-12-31`, `2028-02` → `2028-02-29`. */
export function partialDateEnd(date: string): string {
  if (date.length === 4) return `${date}-12-31`;
  if (date.length === 7) {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${date}-${String(last).padStart(2, '0')}`;
  }
  return date.slice(0, 10);
}

type Dated = Pick<Note, 'startsOn' | 'endsOn'>;

/** The last day an occasion covers (its `ends_on`, else its `starts_on`, at their precision). */
export function occasionEndDay(occasion: Dated): string | undefined {
  const end = occasion.endsOn ?? occasion.startsOn;
  return end ? partialDateEnd(end) : undefined;
}

/**
 * Planned, happening or past by the dates alone: ahead of `starts_on` (at its precision) it is planned,
 * after `ends_on` (or `starts_on` when it has no end) it is past, in between (the day itself, the month of a
 * "2027-01" trip) it is happening. An occasion without dates reads as planned.
 */
export function phaseByDates(
  startsOn: string | null,
  endsOn: string | null,
  today: string,
): 'planned' | 'happening' | 'past' {
  if (!startsOn) return 'planned';
  if (today.slice(0, startsOn.length) < startsOn) return 'planned';
  const end = endsOn ?? startsOn;
  if (today.slice(0, end.length) > end) return 'past';
  return 'happening';
}

/**
 * Where an occasion is today: its stored status when cancelled or archived, past once a writer rewrote it
 * as history, otherwise by its dates (phaseByDates).
 */
export function occasionPhase(occasion: Pick<Note, 'status' | 'startsOn' | 'endsOn'>, today: string): OccasionPhase {
  if (occasion.status === 'archived' || occasion.status === 'cancelled') return occasion.status;
  if (occasion.status === 'past') return 'past';
  return phaseByDates(occasion.startsOn, occasion.endsOn, today);
}

/** Whether a circle or occasion is archived. */
export function isArchived(note: Pick<Note, 'status'>): boolean {
  return note.status === ARCHIVED_STATUS;
}

/** The status a new occasion gets when its writer gave none: past when its dates are behind, else planned. */
export function defaultOccasionStatus(startsOn: string, endsOn: string | null, today: string): OccasionStatus {
  return phaseByDates(startsOn, endsOn, today) === 'past' ? 'past' : 'planned';
}

/** An occasion's dates in words: `2027-01-10`, `2027-01-10 to 2027-01-17`. */
export function occasionDates(occasion: Dated): string {
  if (!occasion.startsOn) return 'undated';
  return occasion.endsOn && occasion.endsOn !== occasion.startsOn
    ? `${occasion.startsOn} to ${occasion.endsOn}`
    : occasion.startsOn;
}

function inDays(n: number): string {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}

function daysAgo(n: number): string {
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  return `${n} days ago`;
}

/**
 * Where an occasion is, relative to today, in a few words: `planned, starts in 12 days`, `happening now`,
 * `past, ended 3 days ago`, `cancelled`, `archived`.
 */
export function describePhase(occasion: Pick<Note, 'status' | 'startsOn' | 'endsOn'>, today: string): string {
  const phase = occasionPhase(occasion, today);
  if (phase === 'planned' && occasion.startsOn) {
    return `planned, starts ${inDays(Math.max(0, daysBetween(today, partialDateStart(occasion.startsOn))))}`;
  }
  if (phase === 'happening') return 'happening now';
  if (phase === 'past') {
    const end = occasionEndDay(occasion);
    return end ? `past, ended ${daysAgo(daysBetween(end, today))}` : 'past';
  }
  return phase;
}

/**
 * How occasions sort for listings, most relevant first: happening, then planned (soonest first), then past
 * and cancelled (most recent first), then archived (most recent first).
 */
export function byOccasionRelevance(today: string): (a: Note, b: Note) => number {
  const rank: Record<OccasionPhase, number> = { happening: 0, planned: 1, past: 2, cancelled: 2, archived: 3 };
  return (a, b) => {
    const pa = occasionPhase(a, today);
    const pb = occasionPhase(b, today);
    if (rank[pa] !== rank[pb]) return rank[pa] - rank[pb];
    const sa = a.startsOn ?? '';
    const sb = b.startsOn ?? '';
    if (sa !== sb) return pa === 'planned' || pa === 'happening' ? sa.localeCompare(sb) : sb.localeCompare(sa);
    return a.title.localeCompare(b.title);
  };
}

/** The most recent `until` of a circle whose members have all left (its last day), or undefined. */
export function lastMemberLeft(circle: Pick<Note, 'members'>): string | undefined {
  if (circle.members.length === 0 || circle.members.some((m) => m.until === null)) return undefined;
  return circle.members
    .map((m) => partialDateEnd(m.until as string))
    .sort()
    .at(-1);
}

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/** A series' valid months, one entry per month (weights and ambient summed, a revival kept), oldest first. */
function normalizeSeries(series: Iterable<ActivityMonth>): ActivityMonth[] {
  const byMonth = new Map<string, ActivityMonth>();
  for (const entry of series) {
    if (!MONTH.test(entry.month)) continue;
    const seen = byMonth.get(entry.month);
    byMonth.set(entry.month, {
      month: entry.month,
      weight: (seen?.weight ?? 0) + Math.max(0, entry.weight),
      ambient: (seen?.ambient ?? 0) + Math.max(0, entry.ambient ?? 0),
      revival: Boolean(seen?.revival || entry.revival),
    });
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** A month's position in calendar months (`2027-03` → 2027 × 12 + 2), for month arithmetic. */
export function monthIndex(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

/**
 * A circle's activity series read the CIRCLE_DECAY way: its stability, its last real month, the newest blip
 * after it (an unconfirmed month, or ambient sightings), its yearly rhythm and its revivals. Undefined
 * without a weighed month (ambient sightings alone are no basis: the circle stays judged by membership).
 */
export function analyzeActivity(series: Iterable<ActivityMonth>): ActivityAnalysis | undefined {
  const all = normalizeSeries(series);
  const weighed = all.filter((m) => m.weight > 0);
  if (weighed.length === 0) return undefined;
  const start = (m: ActivityMonth) => partialDateStart(m.month);
  const near = (a: ActivityMonth, b: ActivityMonth) =>
    Math.abs(monthIndex(a.month) - monthIndex(b.month)) <= CIRCLE_DECAY.confirmMonths;
  let stability: number = CIRCLE_DECAY.initialStabilityDays;
  let anchor = weighed[0];
  let lastBlip: string | undefined;
  const real = new Set<string>([anchor.month]);
  for (let i = 1; i < weighed.length; i++) {
    const month = weighed[i];
    // Judged by the rhythm of the months before it only: a month never makes its own cadence.
    const before = yearlyCadence(weighed.slice(0, i));
    const isReal =
      month.weight >= CIRCLE_DECAY.realReturnWeight ||
      near(month, weighed[i - 1]) ||
      (i + 1 < weighed.length && near(month, weighed[i + 1])) ||
      (before?.months.includes(Number(month.month.slice(5, 7))) ?? false);
    if (isReal) {
      stability += daysBetween(start(anchor), start(month));
      anchor = month;
      lastBlip = undefined;
      real.add(month.month);
    } else {
      stability += CIRCLE_DECAY.blipGainDays;
      lastBlip = month.month;
    }
  }
  // Ambient sightings after the last real month: blip-like, never real, never a confirmation.
  for (const m of all) {
    if (m.weight > 0 || (m.ambient ?? 0) <= 0 || m.month <= anchor.month) continue;
    stability += CIRCLE_DECAY.blipGainDays;
    if (!lastBlip || m.month > lastBlip) lastBlip = m.month;
  }
  const cadence = yearlyCadence(weighed);
  const revivals = all.filter((m) => m.revival).map((m) => ({ month: m.month, confirmed: real.has(m.month) }));
  return {
    stabilityDays: Math.min(stability, CIRCLE_DECAY.maxStabilityDays),
    lastReal: anchor.month,
    ...(lastBlip ? { lastBlip } : {}),
    ...(cadence ? { cadence } : {}),
    revivals,
  };
}

/** A circle's stability in days from its activity (CIRCLE_DECAY); undefined without any. */
export function circleStability(series: Iterable<ActivityMonth>): number | undefined {
  return analyzeActivity(series)?.stabilityDays;
}

/**
 * Where a circle is in its decay today: from its activity (R = exp(−days since the end of its last real
 * month / S), at least exp(−days since a later blip / provisionalStabilityDays), a blip alone never more
 * than fading), or, with none recorded, from its membership (archive once nobody is in it and the last
 * member left CIRCLE_DECAY.fallbackArchiveAfterDays ago; present otherwise).
 */
export function circlePresence(
  circle: Pick<Note, 'members'>,
  series: Iterable<ActivityMonth>,
  today: string,
): CirclePresence {
  const analysis = analyzeActivity(series);
  if (!analysis) {
    const left = lastMemberLeft(circle);
    const archive = left !== undefined && daysBetween(left, today) >= CIRCLE_DECAY.fallbackArchiveAfterDays;
    return { state: archive ? 'archive' : 'present', basis: 'membership' };
  }
  const decay = (month: string, stability: number) =>
    Math.exp(-Math.max(0, daysBetween(partialDateEnd(month), today)) / stability);
  const real = decay(analysis.lastReal, analysis.stabilityDays);
  const blip = analysis.lastBlip ? decay(analysis.lastBlip, CIRCLE_DECAY.provisionalStabilityDays) : 0;
  const r = Math.max(real, blip);
  const state = real >= CIRCLE_DECAY.presentAt ? 'present' : r >= CIRCLE_DECAY.archiveBelow ? 'fading' : 'archive';
  return {
    state,
    r,
    stabilityDays: analysis.stabilityDays,
    lastActive: analysis.lastReal,
    ...(blip > real ? { provisional: true } : {}),
    basis: 'activity',
  };
}

/**
 * A seed of circles' activity (`memory seed-activity`, a notes tree's activity.json): `{"<circle slug>":
 * {"YYYY-MM": weight, …}, …}` with whole weights ≥ 0 (zeros dropped), no month after `today`'s (Eastern);
 * or every problem in it.
 */
export function parseActivitySeed(
  raw: unknown,
  today: string = easternToday(new Date()),
): { ok: true; seed: Map<string, Record<string, number>> } | { ok: false; errors: string[] } {
  const thisMonth = today.slice(0, 7);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['the file must be a JSON object: {"<circle slug>": {"YYYY-MM": weight, …}, …}'] };
  }
  const errors: string[] = [];
  const seed = new Map<string, Record<string, number>>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const slug = normalizeTopic(key);
    if (!slug) {
      errors.push(`"${key.slice(0, 40)}" is not a circle slug`);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${slug}: its months must be an object of "YYYY-MM": weight`);
      continue;
    }
    const months: Record<string, number> = {};
    for (const [month, weight] of Object.entries(value as Record<string, unknown>)) {
      if (!MONTH.test(month)) errors.push(`${slug}: "${month.slice(0, 20)}" is not YYYY-MM`);
      else if (month > thisMonth) errors.push(`${slug} ${month}: a month in the future`);
      else if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 0) {
        errors.push(`${slug} ${month}: the weight must be a whole number ≥ 0`);
      } else if (weight > 0) months[month] = weight;
    }
    seed.set(slug, months);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, seed };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Mar 2027` for `2027-03`. */
export function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7)} ${month.slice(0, 4)}`;
}

/**
 * How a circle's revivals read in its dream input and its trace: `revived Mar 2027` (confirmed), `brief
 * revival Mar 2027` (never confirmed, CIRCLE_DECAY.confirmMonths passed), `back since Mar 2027,
 * provisionally` (still waiting for confirmation).
 */
export function describeRevivals(analysis: ActivityAnalysis | undefined, today: string): string[] {
  return (analysis?.revivals ?? []).map(({ month, confirmed }) => {
    if (confirmed) return `revived ${monthLabel(month)}`;
    const waited = monthIndex(today.slice(0, 7)) - monthIndex(month) > CIRCLE_DECAY.confirmMonths;
    return waited ? `brief revival ${monthLabel(month)}` : `back since ${monthLabel(month)}, provisionally`;
  });
}

/** A yearly rhythm in a circle's activity: the months it happens in (1–12), its seasons, and how to say it. */
export type Cadence = { kind: 'yearly'; months: number[]; seasons: number; label: string };

/**
 * A yearly rhythm: real weight (≥ CIRCLE_DECAY.realReturnWeight) in the same one- or two-month window of the
 * year (December–January wraps: one winter is one season) in at least two different years, with most of the
 * circle's weight (≥ 60%) inside that window, so a circle that is busy all year is not "yearly" (shares are
 * by weight: a little booking chatter in other months doesn't hide the pattern). The window covering the most
 * seasons wins (then the larger share, then the narrower). `yearly (Feb)` after two seasons, `yearly
 * (usually Mar–Apr)` from three. Ambient sightings never count. Undefined when there is none.
 */
export function yearlyCadence(series: Iterable<ActivityMonth>): Cadence | undefined {
  const months = normalizeSeries(series).filter((m) => m.weight > 0);
  if (months.length < 2) return undefined;
  const total = months.reduce((sum, m) => sum + m.weight, 0);
  let best: { window: number[]; seasons: number; share: number } | undefined;
  for (let start = 1; start <= 12; start++) {
    for (const width of [1, 2]) {
      const window = width === 1 ? [start] : [start, (start % 12) + 1];
      const inside = months.filter((m) => window.includes(Number(m.month.slice(5, 7))));
      const bySeason = new Map<number, number>();
      for (const m of inside) {
        const year = Number(m.month.slice(0, 4));
        const season = width === 2 && start === 12 && Number(m.month.slice(5, 7)) === 1 ? year - 1 : year;
        bySeason.set(season, (bySeason.get(season) ?? 0) + m.weight);
      }
      const seasons = [...bySeason.values()].filter((w) => w >= CIRCLE_DECAY.realReturnWeight).length;
      const share = inside.reduce((sum, m) => sum + m.weight, 0) / total;
      if (seasons < 2 || share < 0.6) continue;
      const better =
        !best ||
        seasons > best.seasons ||
        (seasons === best.seasons && share > best.share) ||
        (seasons === best.seasons && share === best.share && window.length < best.window.length);
      if (better) best = { window, seasons, share };
    }
  }
  if (!best) return undefined;
  const names = best.window.map((m) => MONTH_NAMES[m - 1]).join('–');
  return {
    kind: 'yearly',
    months: best.window,
    seasons: best.seasons,
    label: best.seasons >= 3 ? `yearly (usually ${names})` : `yearly (${names})`,
  };
}

/** Why the lifecycle pass archives a note. */
export type ArchiveReason =
  /** A past occasion, OCCASION_LIFECYCLE.archiveAfterDays after it ended. */
  | 'ended'
  /** A cancelled occasion, OCCASION_LIFECYCLE.cancelledArchiveAfterDays after it was cancelled. */
  | 'cancelled'
  /** A circle that faded out (CIRCLE_DECAY: R under archiveBelow, or nobody in it for long without activity). */
  | 'dormant'
  /** Archived by a writer (archived_circles, a status) but still longer than a trace: only compacted. */
  | 'compact'
  /** The owner's one-off `memory archive <slug…>` (bootstrap CLI). */
  | 'requested';

export type ArchiveTask = { note: Note; why: ArchiveReason };

export type LifecyclePlan = {
  /** Occasions over by their dates and never written as history: rewritten as history tonight. */
  history: Note[];
  /** Circles and occasions archived (compacted to a trace) tonight. */
  archive: ArchiveTask[];
  /** Due but left for the following nights (LIFECYCLE_PER_NIGHT). */
  deferred: number;
  /** Live circles that are fading (CIRCLE_DECAY), the faintest first: kept, but only shown when named. */
  fading: Note[];
};

/**
 * Tonight's lifecycle work, capped by LIFECYCLE_PER_NIGHT:
 * - history: occasions written while planned or happening that ended OCCASION_LIFECYCLE.historyGraceDays
 *   or more ago (by their dates), and are not yet due for archiving; the longest over first;
 * - archive, in this order: occasions past (written as history or not) OCCASION_LIFECYCLE.archiveAfterDays
 *   after they ended and cancelled ones cancelledArchiveAfterDays after their last write (the longest over
 *   first); archived notes still longer than NOTE_LIMITS.archivedMaxChars (a writer archived them; never
 *   one the owner last edited: their words stay); circles that faded out (circlePresence over `activity`,
 *   each circle's months by note id: R under CIRCLE_DECAY.archiveBelow, or without activity nobody in it for
 *   fallbackArchiveAfterDays), the lowest R first (those decided by membership first, oldest leaver first).
 * Inactive notes are ignored, and so is a note the owner just undid (its current version an undo, less than
 * UNDO_KEEPS_DAYS old): an undone archive, history rewrite or compaction sticks. Notes whose last step failed
 * on the answer (`failed`: note ids at their current version) go after every untried one in each list, so a
 * few stubborn ones never starve the rest.
 */
export function planLifecycle(args: {
  occasions: Note[];
  circles: Note[];
  today: string;
  activity?: ReadonlyMap<number, ActivityMonth[]>;
  failed?: ReadonlySet<number>;
}): LifecyclePlan {
  const { today } = args;
  const history: { note: Note; end: string }[] = [];
  const archiveOccasions: { task: ArchiveTask; key: string }[] = [];
  const compact: { task: ArchiveTask; key: string }[] = [];

  const needsCompacting = (note: Note) =>
    isArchived(note) && note.content.length > NOTE_LIMITS.archivedMaxChars && note.updatedBy !== 'edit';
  const keptByUndo = (note: Note) => {
    if (note.updatedBy !== 'undo') return false;
    const day = easternDayOfTimestamp(note.updatedAt);
    return day !== undefined && daysBetween(day, today) < UNDO_KEEPS_DAYS;
  };

  for (const occasion of args.occasions) {
    if (!occasion.active || occasion.scope !== 'occasion' || keptByUndo(occasion)) continue;
    if (needsCompacting(occasion)) {
      compact.push({ task: { note: occasion, why: 'compact' }, key: occasion.updatedAt });
      continue;
    }
    const phase = occasionPhase(occasion, today);
    if (phase === 'cancelled') {
      const since = easternDayOfTimestamp(occasion.updatedAt);
      if (since && daysBetween(since, today) >= OCCASION_LIFECYCLE.cancelledArchiveAfterDays) {
        archiveOccasions.push({ task: { note: occasion, why: 'cancelled' }, key: since });
      }
      continue;
    }
    if (phase !== 'past') continue;
    const end = occasionEndDay(occasion);
    if (!end) continue;
    const over = daysBetween(end, today);
    if (over >= OCCASION_LIFECYCLE.archiveAfterDays) {
      archiveOccasions.push({ task: { note: occasion, why: 'ended' }, key: end });
    } else if (
      occasion.status !== 'past' &&
      phaseByDates(occasion.startsOn, occasion.endsOn, today) === 'past' &&
      over >= OCCASION_LIFECYCLE.historyGraceDays
    ) {
      history.push({ note: occasion, end });
    }
  }

  const faded: { task: ArchiveTask; r: number; key: string }[] = [];
  const fading: { note: Note; r: number }[] = [];
  for (const circle of args.circles) {
    if (!circle.active || circle.scope !== 'circle') continue;
    const kept = keptByUndo(circle);
    if (needsCompacting(circle)) {
      if (!kept) compact.push({ task: { note: circle, why: 'compact' }, key: circle.updatedAt });
      continue;
    }
    if (isArchived(circle)) continue;
    const presence = circlePresence(circle, args.activity?.get(circle.id) ?? [], today);
    if (presence.state === 'archive' && kept) {
      fading.push({ note: circle, r: presence.r ?? 0 });
    } else if (presence.state === 'archive') {
      faded.push({
        task: { note: circle, why: 'dormant' },
        r: presence.r ?? -1,
        key: lastMemberLeft(circle) ?? presence.lastActive ?? '',
      });
    } else if (presence.state === 'fading') fading.push({ note: circle, r: presence.r ?? 0 });
  }

  const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
  const untriedFirst = <T>(items: T[], noteOf: (item: T) => Note): T[] => [
    ...items.filter((item) => !args.failed?.has(noteOf(item).id)),
    ...items.filter((item) => args.failed?.has(noteOf(item).id)),
  ];
  const archiveAll = untriedFirst(
    [
      ...archiveOccasions.sort(byKey),
      ...compact.sort(byKey),
      ...faded.sort((a, b) => a.r - b.r || byKey(a, b) || a.task.note.topic.localeCompare(b.task.note.topic)),
    ].map((entry) => entry.task),
    (task) => task.note,
  );
  const historyAll = untriedFirst(
    history.sort((a, b) => a.end.localeCompare(b.end)).map((entry) => entry.note),
    (note) => note,
  );
  return {
    history: historyAll.slice(0, LIFECYCLE_PER_NIGHT.history),
    archive: archiveAll.slice(0, LIFECYCLE_PER_NIGHT.archive),
    deferred:
      Math.max(0, historyAll.length - LIFECYCLE_PER_NIGHT.history) +
      Math.max(0, archiveAll.length - LIFECYCLE_PER_NIGHT.archive),
    fading: fading.sort((a, b) => a.r - b.r || a.note.topic.localeCompare(b.note.topic)).map((f) => f.note),
  };
}
