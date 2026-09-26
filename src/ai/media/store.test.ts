import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import {
  getStoredTranscript,
  getStoredVideoDescription,
  mediaCacheKey,
  storeTranscript,
  storeVideoDescription,
} from './store';

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setBotDbForTesting(undefined);
});

describe('media store', () => {
  it('round-trips transcripts, keeping "no speech" distinct from "never transcribed"', () => {
    expect(getStoredTranscript('m1')).toBeUndefined();
    storeTranscript('m1', '', 'google/gemini-3.5-flash-lite');
    expect(getStoredTranscript('m1')).toBe('');
    storeTranscript('m1', 'second try', 'google/gemini-3.5-flash-lite');
    expect(getStoredTranscript('m1')).toBe('second try');
  });

  it('round-trips video descriptions', () => {
    const key = mediaCacheKey('https://video.twimg.com/a.mp4');
    storeVideoDescription(key, 'a clip', 'google/gemini-3.5-flash-lite');
    expect(getStoredVideoDescription(key)).toBe('a clip');
  });
});

describe('mediaCacheKey', () => {
  it('drops Discord CDN signatures and unifies its two hosts', () => {
    const a = mediaCacheKey('https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=1&is=2&hm=abc');
    const b = mediaCacheKey('https://media.discordapp.net/attachments/1/2/clip.mp4?ex=9&is=8&hm=def#t=3');
    expect(a).toBe('https://cdn.discordapp.com/attachments/1/2/clip.mp4');
    expect(b).toBe(a);
  });

  it('keeps the query elsewhere, where it is part of what the file is', () => {
    expect(mediaCacheKey('https://example.com/video?id=42#x')).toBe('https://example.com/video?id=42');
  });

  it('passes non-URLs through', () => {
    expect(mediaCacheKey('not a url')).toBe('not a url');
  });
});
