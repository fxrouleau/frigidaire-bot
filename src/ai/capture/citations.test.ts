import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '../memory/memoryStore';
import { foldMembers } from '../people';
import { citedEvidence, MAX_RELATED_MEMBERS, relatedMembers, type TranscriptLine } from './citations';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const NOVA_ALT = '100000000000000013';

const BASE = new Date('2026-09-01T14:00:00Z').getTime();
const msgId = (n: number) => String(400_000_000_000_000_000n + BigInt(n));

function transcript(texts: string[], leadIn = 0): Map<number, TranscriptLine> {
  return new Map(
    texts.map((text, i) => {
      const line = i + 1;
      return [line, { line, messageId: msgId(line), at: BASE + line * 60_000, text, leadIn: i < leadIn }];
    }),
  );
}

const LINES = transcript([
  'anyone up for drafts friday',
  'I start the bakery job on monday, day shifts finally',
  'wait… you quit nights?',
  'yeah, “no more 4am alarms” lol',
]);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('citedEvidence', () => {
  it('resolves cited lines to their message ids and keeps a verbatim quote', () => {
    const result = citedEvidence({ evidence: { lines: [2], quote: 'I start the bakery job on monday' } }, LINES);
    expect(result.evidence).toEqual({ messageIds: [msgId(2)], quote: 'I start the bakery job on monday' });
    expect(result.observedAt).toEqual(new Date(BASE + 2 * 60_000));
  });

  it('accepts "#N" strings, bare arrays and fields on the observation itself', () => {
    expect(citedEvidence({ evidence: ['#2', '4'] }, LINES).evidence?.messageIds).toEqual([msgId(2), msgId(4)]);
    expect(citedEvidence({ lines: [3], quote: 'you quit nights' }, LINES).evidence).toEqual({
      messageIds: [msgId(3)],
      quote: 'you quit nights',
    });
    expect(citedEvidence({ evidence: { line: 1 } }, LINES).evidence?.messageIds).toEqual([msgId(1)]);
  });

  it('drops line numbers the request never showed, and junk', () => {
    const result = citedEvidence({ evidence: { lines: [0, 9, -1, 2.5, 'two', null, '#1'] } }, LINES);
    expect(result.evidence?.messageIds).toEqual([msgId(1)]);
    expect(citedEvidence({ evidence: 'line 2' }, LINES)).toEqual({ leadInOnly: false });
    expect(citedEvidence({}, LINES)).toEqual({ leadInOnly: false });
  });

  it('matches quotes whatever their case, spacing, quote marks and elisions', () => {
    const quote = (q: string, lines: number[]) => citedEvidence({ evidence: { lines, quote: q } }, LINES).evidence?.quote;
    expect(quote('"I START the  bakery job"', [2])).toBe('"I START the bakery job"');
    expect(quote('no more 4am alarms', [4])).toBe('no more 4am alarms');
    expect(quote('"no more 4am alarms"', [4])).toBe('"no more 4am alarms"');
    expect(quote('I start … day shifts finally', [2])).toBe('I start … day shifts finally');
    expect(quote('wait... you quit', [3])).toBe('wait... you quit');
    // Pieces out of order are not the message.
    expect(quote('day shifts … I start', [2])).toBeUndefined();
  });

  it('reads a quote across the cited lines together', () => {
    const result = citedEvidence({ evidence: { lines: [3, 4], quote: 'you quit nights? yeah' } }, LINES);
    expect(result.evidence?.quote).toBe('you quit nights? yeah');
  });

  it('cites the line a quote really comes from when the model cited the wrong one', () => {
    const result = citedEvidence({ evidence: { lines: [1], quote: 'day shifts finally' } }, LINES);
    expect(result.evidence).toEqual({ messageIds: [msgId(1), msgId(2)], quote: 'day shifts finally' });
    // With no line cited at all.
    expect(citedEvidence({ evidence: { quote: 'drafts friday' } }, LINES).evidence).toEqual({
      messageIds: [msgId(1)],
      quote: 'drafts friday',
    });
  });

  it('prefers a conversation line over the lead-in when a quote occurs in both', () => {
    const lines = transcript(['gg that was close', 'gg that was close'], 1);
    expect(citedEvidence({ evidence: { quote: 'that was close' } }, lines).evidence?.messageIds).toEqual([msgId(2)]);
  });

  it('flags an observation that rests on lead-in lines only', () => {
    const lines = transcript(['I adopted a husky', 'her name is Pepper', 'anyway drafts friday?'], 2);
    // Cited by number, or found by its quote: taken from what the previous segment already covered.
    expect(citedEvidence({ evidence: { lines: [1, 2] } }, lines).leadInOnly).toBe(true);
    expect(citedEvidence({ evidence: { quote: 'adopted a husky' } }, lines)).toMatchObject({
      evidence: { messageIds: [msgId(1)] },
      leadInOnly: true,
    });
    // A lead-in line cited with a conversation line is context for something new.
    expect(citedEvidence({ evidence: { lines: [2, 3] } }, lines).leadInOnly).toBe(false);
    expect(citedEvidence({ evidence: { lines: [3], quote: 'husky' } }, lines).leadInOnly).toBe(false);
    expect(citedEvidence({}, lines).leadInOnly).toBe(false);
  });

  it('cites every message of a line that merges several (the bootstrap)', () => {
    const merged = new Map<number, TranscriptLine>([
      [1, { line: 1, messageId: msgId(1), messageIds: [msgId(1), msgId(2)], at: BASE, text: '21:40 Remi: bakery at 5am / send help', leadIn: false }],
      [2, { line: 2, messageId: msgId(3), at: BASE + 60_000, text: 'Dale: rip', leadIn: false }],
    ]);
    expect(citedEvidence({ quote: 'Remi: bakery at 5am' }, merged)).toEqual({
      evidence: { messageIds: [msgId(1), msgId(2)], quote: 'Remi: bakery at 5am' },
      observedAt: new Date(BASE),
      leadInOnly: false,
    });
  });

  it('drops an invented quote but keeps the cited lines', () => {
    const result = citedEvidence({ evidence: { lines: [2], quote: 'I love working at the bakery' } }, LINES);
    expect(result.evidence).toEqual({ messageIds: [msgId(2)] });
    expect(citedEvidence({ evidence: { quote: 'never said' } }, LINES)).toEqual({ leadInOnly: false });
  });

  it('clamps the quote and caps the cited lines', () => {
    const long = 'x'.repeat(300);
    const lines = transcript(Array.from({ length: 20 }, (_, i) => (i === 0 ? long : `line ${i}`)));
    const result = citedEvidence(
      { evidence: { lines: Array.from({ length: 20 }, (_, i) => i + 1), quote: long } },
      lines,
    );
    expect(result.evidence?.messageIds).toHaveLength(12);
    expect(result.evidence?.quote?.length).toBe(240);
    expect(result.observedAt).toEqual(new Date(BASE + 12 * 60_000));
  });
});

describe('relatedMembers', () => {
  const identity = (id: string, name: string, extra: Partial<Identity> = {}): Identity => ({
    discord_user_id: id,
    display_name: name,
    canonical_name: name,
    username: name.toLowerCase(),
    irl_name: null,
    aliases: [],
    first_seen_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    active: 1,
    ...extra,
  });
  const members = () =>
    foldMembers([
      identity(REMI, 'Remi'),
      identity(DALE, 'Dale', { aliases: ['Big D'] }),
      identity(NOVA, 'Nova'),
      identity(NOVA_ALT, 'NovaAlt'),
    ]);

  it('keeps known members by id or unique name, as main ids, without the subject', () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${NOVA_ALT}:${NOVA}`);
    const related = relatedMembers(
      { related_user_ids: [DALE, 'Remi', NOVA_ALT, 'big d', REMI] },
      members(),
      REMI,
    );
    expect(related).toEqual([DALE, NOVA]);
  });

  it('drops unknown ids, unknown names, numbers and junk', () => {
    const related = relatedMembers(
      { related: ['100000000000000999', 'Stranger', 100000000000000002, null, '', { id: DALE }, 'server'] },
      members(),
      undefined,
    );
    expect(related).toEqual([]);
    expect(relatedMembers({ related_user_ids: 'Dale' }, members(), undefined)).toEqual([]);
  });

  it(`names at most ${MAX_RELATED_MEMBERS} members`, () => {
    const cast = Array.from({ length: 15 }, (_, i) => identity(String(100_000_000_000_000_100n + BigInt(i)), `Member${i}`));
    const related = relatedMembers(
      { related_user_ids: cast.map((c) => c.discord_user_id) },
      foldMembers(cast),
      undefined,
    );
    expect(related).toHaveLength(MAX_RELATED_MEMBERS);
  });
});
