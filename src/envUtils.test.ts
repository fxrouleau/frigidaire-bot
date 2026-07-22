import { afterEach, describe, expect, it, vi } from 'vitest';
import { envBool } from './envUtils';

const NAME = 'ENV_BOOL_TEST_VAR';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('envBool', () => {
  it('returns the default when the var is unset', () => {
    delete process.env[NAME];
    expect(envBool(NAME, true)).toBe(true);
    expect(envBool(NAME, false)).toBe(false);
  });

  it('returns the default when the var is empty or whitespace-only', () => {
    vi.stubEnv(NAME, '');
    expect(envBool(NAME, true)).toBe(true);
    expect(envBool(NAME, false)).toBe(false);

    vi.stubEnv(NAME, '   ');
    expect(envBool(NAME, true)).toBe(true);
    expect(envBool(NAME, false)).toBe(false);
  });

  it.each(['true', '1', 'yes'])('parses %s as true regardless of default', (value) => {
    vi.stubEnv(NAME, value);
    expect(envBool(NAME, false)).toBe(true);
    expect(envBool(NAME, true)).toBe(true);
  });

  it.each(['false', '0', 'no'])('parses %s as false regardless of default', (value) => {
    vi.stubEnv(NAME, value);
    expect(envBool(NAME, true)).toBe(false);
    expect(envBool(NAME, false)).toBe(false);
  });

  it('is case-insensitive', () => {
    vi.stubEnv(NAME, 'TRUE');
    expect(envBool(NAME, false)).toBe(true);
    vi.stubEnv(NAME, 'False');
    expect(envBool(NAME, true)).toBe(false);
    vi.stubEnv(NAME, 'YES');
    expect(envBool(NAME, false)).toBe(true);
    vi.stubEnv(NAME, 'No');
    expect(envBool(NAME, true)).toBe(false);
  });

  it('tolerates surrounding whitespace and quotes (compose/shell artifacts)', () => {
    vi.stubEnv(NAME, ' true ');
    expect(envBool(NAME, false)).toBe(true);
    vi.stubEnv(NAME, '"true"');
    expect(envBool(NAME, false)).toBe(true);
    vi.stubEnv(NAME, "'false'");
    expect(envBool(NAME, true)).toBe(false);
    vi.stubEnv(NAME, '" 1 "');
    expect(envBool(NAME, false)).toBe(true);
  });

  it('returns the default for unrecognized values', () => {
    for (const junk of ['maybe', '2', 'on', 'off', 'enabled', 'null']) {
      vi.stubEnv(NAME, junk);
      expect(envBool(NAME, true)).toBe(true);
      expect(envBool(NAME, false)).toBe(false);
    }
  });

  it('reads at call time, not module load time', () => {
    vi.stubEnv(NAME, 'false');
    expect(envBool(NAME, true)).toBe(false);
    vi.stubEnv(NAME, 'true');
    expect(envBool(NAME, false)).toBe(true);
  });
});
