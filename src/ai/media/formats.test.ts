import { describe, expect, it } from 'vitest';
import { MKV_BYTES, MP3_BYTES, MP4_BYTES, OGG_BYTES } from '../../test-support/fakeMedia';
import {
  acceptsVideoInput,
  detectAudioFormat,
  detectVideoMime,
  isAudioContentType,
  isVideoContentType,
  nativeAudioFormats,
} from './formats';

function withMagic(magic: string, at = 0, trailer = ''): Buffer {
  const buf = Buffer.alloc(64);
  buf.write(magic, at, 'latin1');
  if (trailer) buf.write(trailer, 8, 'latin1');
  return buf;
}

describe('detectAudioFormat', () => {
  it('trusts the bytes over a wrong declared type', () => {
    expect(detectAudioFormat(OGG_BYTES, 'audio/mpeg')).toBe('ogg');
    expect(detectAudioFormat(MP3_BYTES, 'application/octet-stream')).toBe('mp3');
  });

  it.each([
    [withMagic('fLaC'), 'flac'],
    [withMagic('RIFF', 0, 'WAVE'), 'wav'],
    [withMagic('FORM', 0, 'AIFF'), 'aiff'],
    [withMagic('ftyp', 4), 'm4a'],
    [Buffer.concat([Buffer.from([0xff, 0xf1]), Buffer.alloc(30)]), 'aac'],
    [Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(30)]), 'mp3'],
    [Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(30)]), 'webm'],
  ])('sniffs %#', (data, expected) => {
    expect(detectAudioFormat(data)).toBe(expected);
  });

  it('falls back to the content type (parameters ignored), then the extension', () => {
    const unknown = Buffer.alloc(32);
    expect(detectAudioFormat(unknown, 'audio/ogg; codecs=opus')).toBe('ogg');
    expect(detectAudioFormat(undefined, 'audio/x-m4a')).toBe('m4a');
    expect(detectAudioFormat(unknown, null, 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg?ex=1')).toBe(
      'ogg',
    );
    expect(detectAudioFormat(unknown, null, 'memo.WAV')).toBe('wav');
    expect(detectAudioFormat(unknown, 'application/octet-stream', 'noext')).toBeUndefined();
  });
});

describe('detectVideoMime', () => {
  it('sniffs MP4, QuickTime and WebM, and refuses Matroska/AVI', () => {
    expect(detectVideoMime(MP4_BYTES)).toBe('video/mp4');
    expect(detectVideoMime(withMagic('ftyp', 4, 'qt  '))).toBe('video/mov');
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....webm'), Buffer.alloc(40)]);
    expect(detectVideoMime(webm)).toBe('video/webm');
    expect(detectVideoMime(MKV_BYTES, 'video/x-matroska')).toBeUndefined();
    expect(detectVideoMime(withMagic('RIFF', 0, 'AVI '), 'video/mp4')).toBeUndefined();
  });

  it('maps declared types and extensions when the bytes say nothing', () => {
    const unknown = Buffer.alloc(32);
    expect(detectVideoMime(unknown, 'video/quicktime')).toBe('video/mov');
    expect(detectVideoMime(unknown, 'application/octet-stream', 'https://video.twimg.com/a/b/clip.mp4?tag=12')).toBe(
      'video/mp4',
    );
    expect(detectVideoMime(unknown, 'video/x-msvideo')).toBeUndefined();
  });
});

describe('model capabilities', () => {
  it('sends Gemini the Vertex-documented containers as-is but never Ogg', () => {
    const gemini = nativeAudioFormats('google/gemini-3.5-flash-lite');
    expect([...gemini].sort()).toEqual(['aac', 'flac', 'm4a', 'mp3', 'wav']);
    expect(gemini.has('ogg')).toBe(false);
  });

  it('gives unknown models only wav/mp3', () => {
    expect([...nativeAudioFormats('openai/gpt-audio-mini')].sort()).toEqual(['mp3', 'wav']);
  });

  it('knows Gemini takes video input', () => {
    expect(acceptsVideoInput('google/gemini-3.8-flash')).toBe(true);
    expect(acceptsVideoInput('qwen/qwen3-vl-235b-a22b-instruct')).toBe(false);
  });

  it('classifies content types', () => {
    expect(isAudioContentType('audio/ogg')).toBe(true);
    expect(isAudioContentType('video/mp4')).toBe(false);
    expect(isAudioContentType(null)).toBe(false);
    expect(isVideoContentType('video/quicktime')).toBe(true);
  });
});
