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
    expect(config.agent.maxToolRounds).toBe(10);
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
