import { describe, expect, it } from 'vitest';
import {
  clampSummary,
  NOTE_LIMITS,
  normalizeTopic,
  noteTextProblems,
  parseNotesOutput,
  validateNoteDraft,
  validateNotesOutput,
} from './schema';

const REMI = '100000000000000001';
const DALE = '100000000000000002';

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
      value: { notes: [], removed_topics: [], change_summary: 'nothing' },
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
