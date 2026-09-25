import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INSTAGRAM_FIXERS,
  config,
  describeEffectiveConfig,
  envBool,
  envCsv,
  envEnum,
  envInt,
  envNumber,
  envString,
} from './config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('envBool', () => {
  it.each(['1', 'true', 'TRUE', 'yes', 'on', ' "true" '])('reads %j as true', (value) => {
    vi.stubEnv('FLAG', value);
    expect(envBool('FLAG', false)).toBe(true);
  });

  it.each(['0', 'false', 'False', 'no', 'off', "'0'"])('reads %j as false', (value) => {
    vi.stubEnv('FLAG', value);
    expect(envBool('FLAG', true)).toBe(false);
  });

  it('falls back for unset, blank, or unrecognized values', () => {
    expect(envBool('FLAG', true)).toBe(true);
    vi.stubEnv('FLAG', '   ');
    expect(envBool('FLAG', false)).toBe(false);
    vi.stubEnv('FLAG', 'maybe');
    expect(envBool('FLAG', true)).toBe(true);
  });
});

describe('envInt / envNumber', () => {
  it('parses integers and rejects out-of-range or non-numeric values', () => {
    vi.stubEnv('N', '42');
    expect(envInt('N', 7)).toBe(42);
    vi.stubEnv('N', '0');
    expect(envInt('N', 7, { min: 1 })).toBe(7);
    expect(envInt('N', 7, { min: 0 })).toBe(0);
    vi.stubEnv('N', '4.5');
    expect(envInt('N', 7)).toBe(7);
    vi.stubEnv('N', 'lots');
    expect(envInt('N', 7)).toBe(7);
  });

  it('parses floats within bounds', () => {
    vi.stubEnv('F', '0.75');
    expect(envNumber('F', 0.5, { min: 0, max: 1 })).toBe(0.75);
    vi.stubEnv('F', '7');
    expect(envNumber('F', 0.5, { min: 0, max: 1 })).toBe(0.5);
  });
});

describe('envString / envCsv / envEnum', () => {
  it('trims strings and treats blank as unset', () => {
    vi.stubEnv('S', '  value  ');
    expect(envString('S')).toBe('value');
    vi.stubEnv('S', '');
    expect(envString('S')).toBeUndefined();
  });

  it('splits csv lists and drops empty entries', () => {
    vi.stubEnv('L', ' a, b ,,c ');
    expect(envCsv('L')).toEqual(['a', 'b', 'c']);
    expect(envCsv('MISSING')).toEqual([]);
  });

  it('accepts only listed enum values (case-insensitive)', () => {
    vi.stubEnv('M', 'ALWAYS');
    expect(envEnum('M', ['edgy', 'always'] as const, 'edgy')).toBe('always');
    vi.stubEnv('M', 'sometimes');
    expect(envEnum('M', ['edgy', 'always'] as const, 'edgy')).toBe('edgy');
  });
});

describe('config', () => {
  it('turns features off with either spelling of false (regression: DEBUG_CAPTURE=false used to be ignored)', () => {
    vi.stubEnv('DEBUG_CAPTURE', 'false');
    expect(config.debugCapture.enabled).toBe(false);
    vi.stubEnv('DIGEST_ENABLED', '0');
    expect(config.report.digestEnabled).toBe(false);
    vi.stubEnv('SELF_IMPROVEMENT_ENABLED', 'no');
    expect(config.learner.selfImprovementEnabled).toBe(false);
  });

  it('applies defaults when nothing is set', () => {
    vi.stubEnv('LINK_FIX_VERIFY', undefined);
    expect(config.links.verify).toBe(true);
    expect(config.links.instagramFixers).toEqual(DEFAULT_INSTAGRAM_FIXERS);
    expect(config.deleteRepost.mode).toBe('edgy');
    expect(config.deleteRepost.userIds).toEqual([]);
    expect(config.agent.maxToolRounds).toBe(25);
    expect(config.agent.maxToolInvocations).toBe(200);
    expect(config.agent.chatContextTokens).toBe(131_072);
    expect(config.agent.historyTokenBudget).toBeUndefined();
    expect(config.agent.channelNotes).toEqual({ notes: {}, invalid: false });
    expect(config.models.chatFallbacks).toEqual([]);
  });

  it('defaults the models to what prod runs (an image-capable chat and learner model)', () => {
    for (const name of ['CHAT_MODEL', 'LEARNER_MODEL', 'IMAGE_MODEL', 'SELF_IMPROVEMENT_MODEL', 'DELETE_REPOST_MODEL']) {
      vi.stubEnv(name, undefined);
    }
    // Regression: the old default chat model (deepseek/deepseek-v3.2) was text-only, so a deploy without
    // CHAT_MODEL failed every turn that carried an image, custom emoji or sticker.
    expect(config.models.chat).toBe('z-ai/glm-5.3-flash');
    expect(config.models.learner).toBe('z-ai/glm-5.3-flash');
    expect(config.models.selfImprovement).toBe('z-ai/glm-5.3-flash');
    expect(config.models.image).toBe('google/gemini-3.1-flash-image');
    expect(config.models.messageJudge).toBe('z-ai/glm-5.3-flash');
  });

  it('reads CHAT_FALLBACK_MODELS in order, without duplicates or the primary', () => {
    vi.stubEnv('CHAT_MODEL', 'primary/model');
    vi.stubEnv('CHAT_FALLBACK_MODELS', ' backup/one, primary/model ,backup/two,backup/one ');
    expect(config.models.chatFallbacks).toEqual(['backup/one', 'backup/two']);
  });

  it('takes HISTORY_TOKEN_BUDGET and CHAT_CONTEXT_TOKENS only when they are sane', () => {
    vi.stubEnv('HISTORY_TOKEN_BUDGET', '200000');
    expect(config.agent.historyTokenBudget).toBe(200_000);
    vi.stubEnv('HISTORY_TOKEN_BUDGET', '12');
    expect(config.agent.historyTokenBudget).toBeUndefined();
    vi.stubEnv('HISTORY_TOKEN_BUDGET', 'lots');
    expect(config.agent.historyTokenBudget).toBeUndefined();
    vi.stubEnv('CHAT_CONTEXT_TOKENS', '1310720');
    expect(config.agent.chatContextTokens).toBe(1_310_720);
    vi.stubEnv('CHAT_CONTEXT_TOKENS', '0');
    expect(config.agent.chatContextTokens).toBe(131_072);
  });

  it('parses CHANNEL_NOTES as a JSON object of channel id to note', () => {
    vi.stubEnv('CHANNEL_NOTES', '{"961358115645845654":" banana-combo: the main hangout ","1":42,"2":""}');
    expect(config.agent.channelNotes).toEqual({
      notes: { '961358115645845654': 'banana-combo: the main hangout' },
      invalid: false,
    });
    // A single-quoted .env value still parses (config strips surrounding quotes).
    vi.stubEnv('CHANNEL_NOTES', `'{"3":"clips"}'`);
    expect(config.agent.channelNotes.notes).toEqual({ '3': 'clips' });
  });

  it('flags CHANNEL_NOTES that is not a JSON object instead of throwing', () => {
    for (const bad of ['{not json', '["a","b"]', '"just a string"', 'null']) {
      vi.stubEnv('CHANNEL_NOTES', bad);
      expect(config.agent.channelNotes).toEqual({ notes: {}, invalid: true });
    }
  });

  it('reads the values lazily, so a change is visible on the next access', () => {
    vi.stubEnv('CHAT_MODEL', 'first/model');
    expect(config.models.chat).toBe('first/model');
    vi.stubEnv('CHAT_MODEL', 'second/model');
    expect(config.models.chat).toBe('second/model');
  });

  it('derives the self-improvement and judge models from their parents', () => {
    vi.stubEnv('LEARNER_MODEL', 'learner/model');
    vi.stubEnv('SELF_IMPROVEMENT_MODEL', undefined);
    expect(config.models.selfImprovement).toBe('learner/model');
    vi.stubEnv('CHAT_MODEL', 'chat/model');
    vi.stubEnv('DELETE_REPOST_MODEL', undefined);
    expect(config.models.messageJudge).toBe('chat/model');
  });

  it('never prints the API key in the startup summary', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-super-secret');
    const summary = describeEffectiveConfig();
    expect(summary).toContain('openRouterKey=set');
    expect(summary).not.toContain('super-secret');
  });
});
