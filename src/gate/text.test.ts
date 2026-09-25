import { describe, expect, it } from 'vitest';
import { createNameMatcher, describeBotLastSpoke, isFollowup, readableMarkup, stripMarkup, truncate } from './text';

const NAMES = ['fridge', 'frigidaire', 'frigi', 'bot', 'clanker'];

describe('createNameMatcher', () => {
  const match = createNameMatcher(NAMES);

  it.each([
    ['fridge who wins worlds', 'fridge'],
    ['what do u think Fridge', 'fridge'],
    ['FRIDGE. wake up', 'fridge'],
    ["the fridge's opinion", 'fridge'],
    ['yo frigidaire settle this', 'frigidaire'],
    ['frigi what time is it', 'frigi'],
    ['hey bot', 'bot'],
    ['bot lane is 0/8', 'bot'],
    ['shut up clanker', 'clanker'],
    ['fridge😂', 'fridge'],
    ['(fridge)', 'fridge'],
  ])('matches %j as %s', (text, name) => {
    expect(match(text)).toBe(name);
  });

  it.each([
    'refridgerator broke',
    'two fridges in the garage',
    "it's frigid outside",
    'robots are coming',
    'the bots in coop',
    'he keeps botting',
    'clankers everywhere',
    'fridge_cam is up',
    'éfridge',
    '',
  ])('does not match %j', (text) => {
    expect(match(text)).toBeUndefined();
  });

  it('ignores names inside links, custom emoji markup and mentions', () => {
    expect(match('look https://example.com/fridge/bot')).toBeUndefined();
    expect(match('<:clanker:123456789012345678> lol')).toBeUndefined();
    expect(match('<a:bot:123456789012345678>')).toBeUndefined();
    expect(match('<@123456789012345678> hi')).toBeUndefined();
  });

  it('escapes regex characters in configured names', () => {
    const dotted = createNameMatcher(['fr.dge']);
    expect(dotted('fridge')).toBeUndefined();
    expect(dotted('hey fr.dge')).toBe('fr.dge');
  });

  it('never matches with an empty name list', () => {
    expect(createNameMatcher([])('fridge')).toBeUndefined();
    expect(createNameMatcher(['  '])('fridge')).toBeUndefined();
  });

  it('matches multi-word names', () => {
    expect(createNameMatcher(['cold boy'])('yo cold boy wyd')).toBe('cold boy');
  });
});

describe('isFollowup', () => {
  it('is true when the bot just spoke to this author', () => {
    expect(isFollowup(30, true, 120)).toBe(true);
    expect(isFollowup(120, true, 120)).toBe(true);
    expect(isFollowup(0, true, 120)).toBe(true);
  });

  it('is false past the window, for anyone else, or when unknown', () => {
    expect(isFollowup(121, true, 120)).toBe(false);
    expect(isFollowup(30, false, 120)).toBe(false);
    expect(isFollowup(undefined, true, 120)).toBe(false);
    expect(isFollowup(-5, true, 120)).toBe(false);
  });

  it('is disabled by a 0-second window', () => {
    expect(isFollowup(1, true, 0)).toBe(false);
  });
});

describe('stripMarkup', () => {
  it('drops links, emoji markup, mentions and timestamps', () => {
    expect(stripMarkup('hi <@123456789012345678> see https://x.com/a <:pog:123456789012345678> at <t:1700000000:R>')).toBe(
      'hi see at',
    );
  });
});

describe('readableMarkup', () => {
  it('renders markup the way a person reads it', () => {
    const text = readableMarkup(
      '<@111111111111111111> look <:pepeLaugh:123456789012345678> in <#222222222222222222> <@333333333333333333>',
      (id) => (id === '111111111111111111' ? 'Kev' : undefined),
    );
    expect(text).toBe('@Kev look :pepeLaugh: in #channel @someone');
  });
});

describe('truncate', () => {
  it('keeps short text and cuts long text with an ellipsis', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('a'.repeat(20), 10)).toBe(`${'a'.repeat(9)}…`);
  });
});

describe('describeBotLastSpoke', () => {
  it('describes the gap in words', () => {
    expect(describeBotLastSpoke(undefined)).toMatch(/^not recently/);
    expect(describeBotLastSpoke(5)).toMatch(/^just now/);
    expect(describeBotLastSpoke(45)).toBe('45 seconds before the latest message');
    expect(describeBotLastSpoke(90)).toBe('about a minute before the latest message');
    expect(describeBotLastSpoke(300)).toBe('5 minutes before the latest message');
    expect(describeBotLastSpoke(3600)).toMatch(/^not recently/);
  });
});
