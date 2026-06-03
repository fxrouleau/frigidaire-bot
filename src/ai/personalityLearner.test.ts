import { describe, expect, it } from 'vitest';
import {
  buildPersonalityPrompt,
  buildSelfImprovementPrompt,
  normalizeObservationCategory,
  type Observation,
  type ObservationCategory,
  parseLearnerOutput,
} from './personalityLearner';

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

  it('accepts the ephemeral image category (expired by the TTL sweep)', () => {
    const obs: Observation = { category: 'image', subject: 'Jason', content: 'Shared a meme about League ranked' };
    expect(obs.category).toBe('image');
  });

  it('ObservationCategory includes all expected values', () => {
    const allCategories: ObservationCategory[] = [
      'fact',
      'preference',
      'personality',
      'event',
      'vibe',
      'image',
      'capability_gap',
      'pain_point',
      'feature_request',
      'improvement_idea',
    ];
    expect(allCategories).toHaveLength(10);
  });
});

describe('normalizeObservationCategory (runtime whitelist)', () => {
  it('accepts every valid category as-is', () => {
    const valid: ObservationCategory[] = [
      'fact',
      'preference',
      'personality',
      'event',
      'vibe',
      'image',
      'capability_gap',
      'pain_point',
      'feature_request',
      'improvement_idea',
    ];
    for (const category of valid) {
      expect(normalizeObservationCategory(category)).toBe(category);
    }
  });

  it('normalizes case and whitespace drift from the LLM', () => {
    expect(normalizeObservationCategory('Image')).toBe('image');
    expect(normalizeObservationCategory('EVENT')).toBe('event');
    expect(normalizeObservationCategory('  fact ')).toBe('fact');
  });

  it('rejects hallucinated categories (they would bypass the TTL sweep)', () => {
    expect(normalizeObservationCategory('meme')).toBeUndefined();
    expect(normalizeObservationCategory('images')).toBeUndefined();
    expect(normalizeObservationCategory('observation')).toBeUndefined();
    expect(normalizeObservationCategory('')).toBeUndefined();
    expect(normalizeObservationCategory('fact;DROP TABLE memories')).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Prompt-rule verification: the prompts are the learner's only behavioral spec (the model does what the
// prompt says, not what the code intends), so the key anti-junk rules are pinned here. If a rule phrase
// is reworded, update the assertion — but removing a rule should be a deliberate, reviewed decision.
// ---------------------------------------------------------------------------

describe('buildPersonalityPrompt (memory-quality rules)', () => {
  // Sentinel args prove the dynamic sections are interpolated into the prompt the model actually sees.
  const prompt = buildPersonalityPrompt({
    identitiesSection: '<<IDENTITIES_SECTION>>',
    emojisSection: '<<EMOJIS_SECTION>>',
    existingMemoriesSummary: '<<EXISTING_MEMORIES>>',
  });

  it('applies the 30-day durable-knowledge test (memories, not transcription)', () => {
    expect(prompt).toContain('THE 30-DAY TEST');
    expect(prompt).toContain('still be true and useful in 30 days');
    expect(prompt).toContain('transcription, not a memory');
  });

  it('requires time-bound observations to use the event category (14-day TTL)', () => {
    expect(prompt).toContain('Anything time-bound MUST be "event"');
    expect(prompt).toContain('events expire automatically after ~2 weeks');
  });

  it('requires image/GIF shares to use the image category (24-hour TTL)', () => {
    expect(prompt).toContain('Any observation describing an image share MUST be "image"');
    expect(prompt).toContain('expire automatically after ~a day');
  });

  it('requires current-display-name subjects with Discord IDs (identity normalization)', () => {
    // Subjects key on the CURRENT display name (consistent with every getBySubject() lookup and all
    // existing prod memories); subject_user_id is the stable identity anchor across name changes.
    expect(prompt).toContain("MUST be the person's CURRENT display name");
    expect(prompt).toContain('(now: CurrentName)');
    expect(prompt).toContain('"subject_user_id" MUST be their Discord ID');
    // The earlier canonical-name keying is gone — prod canonical names are stale first-seen usernames
    // ('gigacheese', 'chinkichanga'), and keying on them would split the memory keyspace.
    expect(prompt).not.toContain('canonical name from the known server identities list');
  });

  it('offers the full category set including image in the JSON output template', () => {
    expect(prompt).toContain('fact|preference|personality|event|vibe|image');
  });

  it('interpolates the identities, emojis, and existing-memories sections', () => {
    expect(prompt).toContain('<<IDENTITIES_SECTION>>');
    expect(prompt).toContain('<<EMOJIS_SECTION>>');
    expect(prompt).toContain('<<EXISTING_MEMORIES>>');
  });

  it('contains no content-censoring instructions (observations stay verbatim)', () => {
    // Felix's explicit exclusion: authentic observations are kept as-is, never sanitized.
    expect(prompt).not.toMatch(/censor/i);
    expect(prompt).not.toMatch(/paraphras/i);
    expect(prompt).not.toMatch(/never quote/i);
    expect(prompt).not.toMatch(/saniti[sz]e/i);
  });
});

describe('buildSelfImprovementPrompt (anti-junk rules)', () => {
  const prompt = buildSelfImprovementPrompt({
    botName: 'TestFridgeName',
    existingSelfImprovementSummary: '<<EXISTING_SELF_IMPROVEMENT>>',
  });

  it('applies the 30-day test to self-improvement signals', () => {
    expect(prompt).toContain('The 30-day test');
    expect(prompt).toContain('"User shared X and got no bot response" is transcription of one moment');
  });

  it('forbids re-saving issues already covered by existing observations', () => {
    expect(prompt).toContain('re-saving anything semantically covered there is the #1 failure mode');
    expect(prompt).toContain('"User shared X but received no bot engagement" entries');
  });

  it('interpolates the bot name and the existing observations summary', () => {
    expect(prompt).toContain('TestFridgeName');
    expect(prompt).toContain('<<EXISTING_SELF_IMPROVEMENT>>');
  });

  it('contains no content-censoring instructions', () => {
    expect(prompt).not.toMatch(/censor/i);
    expect(prompt).not.toMatch(/paraphras/i);
    expect(prompt).not.toMatch(/never quote/i);
    expect(prompt).not.toMatch(/saniti[sz]e/i);
  });
});
