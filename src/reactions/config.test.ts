import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import { autoReactSettings } from './index';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('config.autoReact', () => {
  it('defaults: shadow mode on the main channel, 3 a day, 45 minutes apart, 200 reacted posts first', () => {
    vi.stubEnv('MAIN_CHANNEL_ID', '961358115645845000');
    expect(config.autoReact.mode).toBe('shadow');
    expect(config.autoReact.channelIds).toEqual(['961358115645845000']);
    expect(config.autoReact.maxPerDay).toBe(3);
    expect(config.autoReact.minGapMinutes).toBe(45);
    expect(config.autoReact.minProfileMessages).toBe(200);
    expect(config.autoReact.delaySeconds).toBe(10);
  });

  it('no main channel and no AUTO_REACT_CHANNELS ⇒ no channels', () => {
    vi.stubEnv('MAIN_CHANNEL_ID', '');
    expect(config.autoReact.channelIds).toEqual([]);
  });

  it('reads overrides, and falls back to the defaults on bad values', () => {
    vi.stubEnv('AUTO_REACT_MODE', 'ON');
    vi.stubEnv('AUTO_REACT_CHANNELS', ' 1, 2 ');
    vi.stubEnv('AUTO_REACT_MAX_PER_DAY', '0');
    vi.stubEnv('AUTO_REACT_MIN_GAP_MINUTES', '7.5');
    vi.stubEnv('AUTO_REACT_DELAY_SECONDS', '0');
    expect(config.autoReact.mode).toBe('on');
    expect(config.autoReact.channelIds).toEqual(['1', '2']);
    expect(config.autoReact.maxPerDay).toBe(0);
    expect(config.autoReact.minGapMinutes).toBe(7.5);
    expect(config.autoReact.delaySeconds).toBe(10);
    vi.stubEnv('AUTO_REACT_MODE', 'loud');
    vi.stubEnv('AUTO_REACT_MAX_PER_DAY', '-1');
    expect(config.autoReact.mode).toBe('shadow');
    expect(config.autoReact.maxPerDay).toBe(3);
  });

  it('turns into the reactor settings, with the gate follow-up window as the exchange window', () => {
    vi.stubEnv('AUTO_REACT_MIN_GAP_MINUTES', '30');
    vi.stubEnv('GATE_FOLLOWUP_SECONDS', '90');
    expect(autoReactSettings()).toMatchObject({ minGapMs: 30 * 60_000, delayMs: 10_000, exchangeWindowMs: 90_000 });
    vi.stubEnv('GATE_ENABLED', 'false');
    expect(autoReactSettings().exchangeWindowMs).toBe(0);
  });
});

describe('config.emoji usage captions', () => {
  it('weekly job on, one-shot flag off by default', () => {
    expect(config.emoji.usageCaptionsEnabled).toBe(true);
    expect(config.emoji.recaptionFromUsage).toBe(false);
    vi.stubEnv('EMOJI_USAGE_CAPTIONS_ENABLED', 'no');
    vi.stubEnv('EMOJI_RECAPTION_FROM_USAGE', '1');
    expect(config.emoji.usageCaptionsEnabled).toBe(false);
    expect(config.emoji.recaptionFromUsage).toBe(true);
  });
});
