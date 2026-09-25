// Container detection for downloaded media, and which formats each model family takes as-is.
//
// Detection trusts the bytes first (magic numbers), then the declared content type, then the file
// extension: Discord's contentType is usually right, but third-party CDNs behind shared links
// regularly serve video as application/octet-stream.

/** Audio `format` values OpenRouter's `input_audio` content part documents. */
export type AudioFormat = 'wav' | 'mp3' | 'aiff' | 'aac' | 'ogg' | 'flac' | 'm4a' | 'webm';

/** Video MIME types OpenRouter's `video_url` content part documents for data URLs. */
export type VideoMime = 'video/mp4' | 'video/mpeg' | 'video/mov' | 'video/webm';

const AUDIO_CONTENT_TYPES: Record<string, AudioFormat> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpeg3': 'mp3',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/vorbis': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/webm': 'webm',
};

const AUDIO_EXTENSIONS: Record<string, AudioFormat> = {
  wav: 'wav',
  mp3: 'mp3',
  aif: 'aiff',
  aiff: 'aiff',
  aac: 'aac',
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'ogg',
  flac: 'flac',
  m4a: 'm4a',
  mp4: 'm4a',
  webm: 'webm',
};

const VIDEO_CONTENT_TYPES: Record<string, VideoMime> = {
  'video/mp4': 'video/mp4',
  'video/quicktime': 'video/mov',
  'video/mov': 'video/mov',
  'video/webm': 'video/webm',
  'video/mpeg': 'video/mpeg',
};

const VIDEO_EXTENSIONS: Record<string, VideoMime> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mov',
  webm: 'video/webm',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
};

function baseContentType(contentType: string | null | undefined): string | undefined {
  const base = contentType?.split(';')[0]?.trim().toLowerCase();
  return base && base.length > 0 ? base : undefined;
}

function extensionOf(nameOrUrl: string | undefined): string | undefined {
  if (!nameOrUrl) return undefined;
  let pathname = nameOrUrl;
  try {
    pathname = new URL(nameOrUrl).pathname;
  } catch {
    // Not a URL: a bare file name.
  }
  const match = pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return match?.[1];
}

function ascii(data: Buffer, start: number, end: number): string {
  return data.length >= end ? data.toString('latin1', start, end) : '';
}

function sniffAudio(data: Buffer): AudioFormat | undefined {
  if (data.length < 12) return undefined;
  if (ascii(data, 0, 4) === 'OggS') return 'ogg';
  if (ascii(data, 0, 4) === 'fLaC') return 'flac';
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WAVE') return 'wav';
  if (ascii(data, 0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(data, 8, 12))) return 'aiff';
  if (ascii(data, 4, 8) === 'ftyp') return 'm4a';
  if (data.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  if (ascii(data, 0, 3) === 'ID3') return 'mp3';
  // ADTS (raw AAC) and MPEG audio share the 0xFFF sync word; ADTS has layer bits 00.
  if (data[0] === 0xff && (data[1] & 0xf6) === 0xf0) return 'aac';
  if (data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return 'mp3';
  return undefined;
}

function sniffVideo(data: Buffer): VideoMime | 'unsupported' | undefined {
  if (data.length < 12) return undefined;
  if (ascii(data, 4, 8) === 'ftyp') {
    return ascii(data, 8, 12) === 'qt  ' ? 'video/mov' : 'video/mp4';
  }
  if (data.readUInt32BE(0) === 0x1a45dfa3) {
    // EBML: WebM declares its doctype near the start; anything else is generic Matroska.
    return data.toString('latin1', 0, Math.min(data.length, 64)).includes('webm') ? 'video/webm' : 'unsupported';
  }
  if (data.readUInt32BE(0) === 0x000001ba || data.readUInt32BE(0) === 0x000001b3) return 'video/mpeg';
  if (ascii(data, 0, 4) === 'RIFF' || ascii(data, 0, 3) === 'FLV') return 'unsupported';
  // MPEG-TS: a 0x47 sync byte at the start of every 188-byte packet.
  if (data[0] === 0x47 && data.length > 188 && data[188] === 0x47) return 'unsupported';
  return undefined;
}

/** The audio container of a file, or undefined when it is not one OpenRouter documents. */
export function detectAudioFormat(
  data: Buffer | undefined,
  contentType?: string | null,
  nameOrUrl?: string,
): AudioFormat | undefined {
  const sniffed = data ? sniffAudio(data) : undefined;
  if (sniffed) return sniffed;
  const declared = baseContentType(contentType);
  if (declared && AUDIO_CONTENT_TYPES[declared]) return AUDIO_CONTENT_TYPES[declared];
  const extension = extensionOf(nameOrUrl);
  return extension ? AUDIO_EXTENSIONS[extension] : undefined;
}

/**
 * The MIME type to put on a video data URL, or undefined when the container is not one the video
 * endpoint documents (Matroska, AVI, FLV, MPEG-TS go through keyframe sampling instead).
 */
export function detectVideoMime(
  data: Buffer | undefined,
  contentType?: string | null,
  nameOrUrl?: string,
): VideoMime | undefined {
  const sniffed = data ? sniffVideo(data) : undefined;
  if (sniffed === 'unsupported') return undefined;
  if (sniffed) return sniffed;
  const declared = baseContentType(contentType);
  if (declared && VIDEO_CONTENT_TYPES[declared]) return VIDEO_CONTENT_TYPES[declared];
  const extension = extensionOf(nameOrUrl);
  return extension ? VIDEO_EXTENSIONS[extension] : undefined;
}

// What a model accepts without transcoding. Gemini is served with ZDR only on Google Vertex, whose
// documented audio inputs are aac/flac/mp3/m4a/mpeg/opus/pcm/wav/webm — notably not audio/ogg, the
// container of every Discord voice message — so Ogg is transcoded to MP3 rather than risked. Any other
// model gets the two formats every audio-input model on OpenRouter takes (and the only two the OpenAI
// SDK types admit). A native send that is still rejected falls back to MP3 (see transcriber.ts).
const GEMINI_AUDIO_FORMATS: ReadonlySet<AudioFormat> = new Set(['wav', 'mp3', 'aac', 'flac', 'm4a']);
const BASELINE_AUDIO_FORMATS: ReadonlySet<AudioFormat> = new Set(['wav', 'mp3']);

export function nativeAudioFormats(model: string): ReadonlySet<AudioFormat> {
  return isGemini(model) ? GEMINI_AUDIO_FORMATS : BASELINE_AUDIO_FORMATS;
}

function isGemini(model: string): boolean {
  return model.toLowerCase().startsWith('google/gemini');
}

export function isAudioContentType(contentType: string | null | undefined): boolean {
  return baseContentType(contentType)?.startsWith('audio/') ?? false;
}

export function isVideoContentType(contentType: string | null | undefined): boolean {
  return baseContentType(contentType)?.startsWith('video/') ?? false;
}
