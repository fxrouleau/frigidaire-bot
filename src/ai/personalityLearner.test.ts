import { describe, expect, it } from 'vitest';
import { type Observation, type ObservationCategory, parseLearnerOutput } from './personalityLearner';

describe('Observation type', () => {
  it('accepts existing personality categories', () => {
    const obs: Observation = { category: 'fact', subject: 'Felix', content: 'Likes cats' };
    expect(obs.category).toBe('fact');

    const obs2: Observation = { category: 'preference', subject: 'Felix', content: 'Prefers tea' };
    expect(obs2.category).toBe('preference');

    const obs3: Observation = { category: 'personality', subject: 'Felix', content: 'Dry humor' };
    expect(obs3.category).toBe('personality');

    const obs4: Observation = { category: 'event', subject: 'server', content: 'Game night' };
    expect(obs4.category).toBe('event');

    const obs5: Observation = { category: 'vibe', subject: 'server', content: 'Chill vibes' };
    expect(obs5.category).toBe('vibe');
  });

  it('accepts new self-improvement categories', () => {
    const obs1: Observation = { category: 'capability_gap', subject: 'bot', content: 'Cannot read PDFs' };
    expect(obs1.category).toBe('capability_gap');

    const obs2: Observation = { category: 'pain_point', subject: 'bot', content: 'Responds too often' };
    expect(obs2.category).toBe('pain_point');

    const obs3: Observation = { category: 'feature_request', subject: 'bot', content: 'Add reminders' };
    expect(obs3.category).toBe('feature_request');

    const obs4: Observation = { category: 'improvement_idea', subject: 'bot', content: 'Shorter responses' };
    expect(obs4.category).toBe('improvement_idea');
  });

  it('ObservationCategory includes all expected values', () => {
    const allCategories: ObservationCategory[] = [
      'fact',
      'preference',
      'personality',
      'event',
      'vibe',
      'capability_gap',
      'pain_point',
      'feature_request',
      'improvement_idea',
    ];
    expect(allCategories).toHaveLength(9);
  });
});

describe('parseLearnerOutput', () => {
  it('parses the canonical object format', () => {
    const raw = `{
      "observations": [
        {"category": "fact", "subject": "Wheezer", "subject_user_id": "123", "content": "Likes cats"}
      ],
      "identity_updates": [
        {"discord_user_id": "123", "irl_name": "Derrick"}
      ]
    }`;
    const parsed = parseLearnerOutput(raw);
    expect(parsed).toBeDefined();
    expect(parsed?.observations).toHaveLength(1);
    expect(parsed?.observations[0].subject_user_id).toBe('123');
    expect(parsed?.identity_updates).toHaveLength(1);
    expect(parsed?.identity_updates?.[0].irl_name).toBe('Derrick');
  });

  it('accepts object without identity_updates', () => {
    const raw = '{"observations": [{"category": "vibe", "subject": "server", "content": "silly"}]}';
    const parsed = parseLearnerOutput(raw);
    expect(parsed?.observations).toHaveLength(1);
    expect(parsed?.identity_updates).toBeUndefined();
  });

  it('falls back to legacy array format', () => {
    const raw = '[{"category": "fact", "subject": "Jason", "content": "Likes TFT"}]';
    const parsed = parseLearnerOutput(raw);
    expect(parsed?.observations).toHaveLength(1);
    expect(parsed?.observations[0].subject).toBe('Jason');
    expect(parsed?.identity_updates).toBeUndefined();
  });

  it('extracts JSON object from surrounding prose', () => {
    const raw =
      'Here is what I found:\n\n{"observations": [{"category": "fact", "subject": "A", "content": "b"}]}\n\nDone.';
    const parsed = parseLearnerOutput(raw);
    expect(parsed?.observations).toHaveLength(1);
  });

  it('extracts JSON array from surrounding prose (legacy)', () => {
    const raw = 'Here is what I found:\n\n[{"category": "fact", "subject": "A", "content": "b"}]\n\nDone.';
    const parsed = parseLearnerOutput(raw);
    expect(parsed?.observations).toHaveLength(1);
  });

  it('returns undefined on malformed input', () => {
    expect(parseLearnerOutput('not json at all')).toBeUndefined();
    expect(parseLearnerOutput('{incomplete')).toBeUndefined();
  });

  it('returns undefined when observations field is missing or not an array', () => {
    expect(parseLearnerOutput('{"foo": "bar"}')).toBeUndefined();
    expect(parseLearnerOutput('{"observations": "not-an-array"}')).toBeUndefined();
  });

  it('accepts empty observations array', () => {
    const parsed = parseLearnerOutput('{"observations": []}');
    expect(parsed?.observations).toEqual([]);
  });
});
