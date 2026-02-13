import { describe, expect, it } from 'vitest';
import { BOT_ALIASES, contentAddressesBot } from './gateClassifier';

describe('contentAddressesBot', () => {
  const botName = 'Frigidaire';

  it('matches direct bot name mention', () => {
    expect(contentAddressesBot('Frigidaire what time is it', botName)).toBe(true);
  });

  it('matches alias "fridge"', () => {
    expect(contentAddressesBot('hey fridge', botName)).toBe(true);
  });

  it('matches alias "bot"', () => {
    expect(contentAddressesBot("bot what's up", botName)).toBe(true);
  });

  it('matches alias "fridge bot"', () => {
    expect(contentAddressesBot('fridge bot help', botName)).toBe(true);
  });

  it('is case insensitive', () => {
    expect(contentAddressesBot("FRIDGE what's up", botName)).toBe(true);
  });

  it('does not match "robot" for alias "bot" (word boundary)', () => {
    expect(contentAddressesBot('robot is cool', botName)).toBe(false);
  });

  it('does not match "about" for alias "bot" (word boundary)', () => {
    expect(contentAddressesBot('what about that', botName)).toBe(false);
  });

  it('returns false when no bot reference', () => {
    expect(contentAddressesBot("hey guys what's up", botName)).toBe(false);
  });

  it('matches bot name in different case', () => {
    expect(contentAddressesBot('frigidaire help me', botName)).toBe(true);
  });
});

describe('BOT_ALIASES', () => {
  it('is an array containing expected aliases', () => {
    expect(BOT_ALIASES).toContain('fridge');
    expect(BOT_ALIASES).toContain('bot');
    expect(BOT_ALIASES).toContain('frigidaire');
  });
});
