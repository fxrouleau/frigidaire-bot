import { describe, expect, it } from 'vitest';
import type { Observation, ObservationCategory } from './personalityLearner';

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
