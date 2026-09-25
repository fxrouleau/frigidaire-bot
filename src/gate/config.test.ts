import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';

const GATE_VARS = [
  'MAIN_CHANNEL_ID',
  'GATE_ENABLED',
  'GATE_CHANNELS',
  'GATE_NAMES',
  'GATE_FOLLOWUP_SECONDS',
  'GATE_MAX_PER_10MIN',
  'GATE_THRESHOLD',
  'GATE_MODEL',
  'RAMBLE_USER_IDS',
  'RAMBLE_CHANNEL_ID',
  'RAMBLE_WATCH_CHANNELS',
  'RAMBLE_MIN_MESSAGES',
  'RAMBLE_MIN_CHARS',
  'RAMBLE_WINDOW_SECONDS',
  'RAMBLE_COOLDOWN_MINUTES',
  'RAMBLE_THRESHOLD',
];

function clearAll() {
  for (const name of GATE_VARS) vi.stubEnv(name, undefined);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('config.gate', () => {
  it('has the documented defaults, and is off with no channel configured', () => {
    clearAll();
    expect(config.gate.enabled).toBe(true);
    expect(config.gate.channelIds).toEqual([]);
    expect(config.gate.names).toEqual(['fridge', 'frigidaire', 'frigi', 'bot', 'clanker']);
    expect(config.gate.followupSeconds).toBe(120);
    expect(config.gate.maxPer10Min).toBe(4);
    expect(config.gate.threshold).toBe(0.7);
    expect(config.gate.model).toBe('typesafe/jev-1.13');
  });

  it('defaults the channels to MAIN_CHANNEL_ID, and GATE_CHANNELS overrides it', () => {
    clearAll();
    vi.stubEnv('MAIN_CHANNEL_ID', 'main-1');
    expect(config.gate.channelIds).toEqual(['main-1']);
    vi.stubEnv('GATE_CHANNELS', ' a-1 , b-2 ');
    expect(config.gate.channelIds).toEqual(['a-1', 'b-2']);
  });

  it('parses overrides and falls back on invalid values', () => {
    clearAll();
    vi.stubEnv('GATE_ENABLED', 'off');
    vi.stubEnv('GATE_NAMES', 'Fridge, Toaster');
    vi.stubEnv('GATE_FOLLOWUP_SECONDS', '0');
    vi.stubEnv('GATE_MAX_PER_10MIN', '-3');
    vi.stubEnv('GATE_THRESHOLD', '1.5');
    expect(config.gate.enabled).toBe(false);
    expect(config.gate.names).toEqual(['fridge', 'toaster']);
    expect(config.gate.followupSeconds).toBe(0);
    expect(config.gate.maxPer10Min).toBe(4);
    expect(config.gate.threshold).toBe(0.7);
  });

  it('accepts only decision models for GATE_MODEL', () => {
    clearAll();
    vi.stubEnv('GATE_MODEL', '~typesafe/jev-latest');
    expect(config.gate.model).toBe('~typesafe/jev-latest');
    vi.stubEnv('GATE_MODEL', 'deepseek/deepseek-v3.2');
    expect(config.gate.model).toBe('typesafe/jev-1.13');
  });
});

describe('config.ramble', () => {
  it('is off by default and watches the main channel', () => {
    clearAll();
    expect(config.ramble.userIds).toEqual([]);
    expect(config.ramble.channelId).toBeUndefined();
    expect(config.ramble.watchChannelIds).toEqual([]);
    vi.stubEnv('MAIN_CHANNEL_ID', 'main-1');
    expect(config.ramble.watchChannelIds).toEqual(['main-1']);
    expect(config.ramble.minMessages).toBe(4);
    expect(config.ramble.minChars).toBe(800);
    expect(config.ramble.windowSeconds).toBe(300);
    expect(config.ramble.cooldownMinutes).toBe(120);
    expect(config.ramble.threshold).toBe(0.7);
  });

  it('parses overrides and falls back on invalid values', () => {
    clearAll();
    vi.stubEnv('RAMBLE_USER_IDS', 'u1,u2');
    vi.stubEnv('RAMBLE_CHANNEL_ID', 'ramble-1');
    vi.stubEnv('RAMBLE_WATCH_CHANNELS', 'main-1,clips-1');
    vi.stubEnv('RAMBLE_MIN_MESSAGES', '0');
    vi.stubEnv('RAMBLE_MIN_CHARS', '1200');
    vi.stubEnv('RAMBLE_WINDOW_SECONDS', 'soon');
    vi.stubEnv('RAMBLE_COOLDOWN_MINUTES', '30');
    vi.stubEnv('RAMBLE_THRESHOLD', '0.8');
    expect(config.ramble.userIds).toEqual(['u1', 'u2']);
    expect(config.ramble.channelId).toBe('ramble-1');
    expect(config.ramble.watchChannelIds).toEqual(['main-1', 'clips-1']);
    expect(config.ramble.minMessages).toBe(4);
    expect(config.ramble.minChars).toBe(1200);
    expect(config.ramble.windowSeconds).toBe(300);
    expect(config.ramble.cooldownMinutes).toBe(30);
    expect(config.ramble.threshold).toBe(0.8);
  });
});
