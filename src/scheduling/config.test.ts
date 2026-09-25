import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('config.reminders', () => {
  it('caps pending reminders per user at 25 by default', () => {
    vi.stubEnv('REMINDERS_MAX_PER_USER', '');
    expect(config.reminders.maxPerUser).toBe(25);
    vi.stubEnv('REMINDERS_MAX_PER_USER', '5');
    expect(config.reminders.maxPerUser).toBe(5);
    vi.stubEnv('REMINDERS_MAX_PER_USER', '0');
    expect(config.reminders.maxPerUser).toBe(25);
  });
});

describe('config.birthdays', () => {
  it('announces in BIRTHDAY_CHANNEL_ID, else MAIN_CHANNEL_ID, else nowhere', () => {
    vi.stubEnv('BIRTHDAY_CHANNEL_ID', '');
    vi.stubEnv('MAIN_CHANNEL_ID', '');
    expect(config.birthdays.channelId).toBeUndefined();
    vi.stubEnv('MAIN_CHANNEL_ID', '900000000000000001');
    expect(config.birthdays.channelId).toBe('900000000000000001');
    vi.stubEnv('BIRTHDAY_CHANNEL_ID', '900000000000000002');
    expect(config.birthdays.channelId).toBe('900000000000000002');
  });

  it('announces from 15:00 by default and only accepts hours 0–23', () => {
    vi.stubEnv('BIRTHDAY_ANNOUNCE_HOUR', '');
    expect(config.birthdays.announceHour).toBe(15);
    vi.stubEnv('BIRTHDAY_ANNOUNCE_HOUR', '0');
    expect(config.birthdays.announceHour).toBe(0);
    vi.stubEnv('BIRTHDAY_ANNOUNCE_HOUR', '24');
    expect(config.birthdays.announceHour).toBe(15);
  });

  it('reads the seed as a csv list and the kill switch as a boolean', () => {
    vi.stubEnv('BIRTHDAYS_SEED', ' 1:09-25, 2:1990-01-02 ,');
    expect(config.birthdays.seed).toEqual(['1:09-25', '2:1990-01-02']);
    vi.stubEnv('BIRTHDAY_ANNOUNCE_ENABLED', '');
    expect(config.birthdays.announceEnabled).toBe(true);
    vi.stubEnv('BIRTHDAY_ANNOUNCE_ENABLED', 'off');
    expect(config.birthdays.announceEnabled).toBe(false);
  });
});
