// Fakes for the media features: a scripted transcoder (so no test ever needs ffmpeg), an OpenRouter
// client that replays fixtures while capturing each request's body AND headers (the feature tag rides
// in a header), and a fetch that serves in-memory files by URL.
import OpenAI from 'openai';
import type { MediaTranscoder, ProbeResult, VideoSample } from '../ai/media/transcoder';
import type { ModelCatalog, ModelInfo } from '../ai/modelCatalog';
import type { OpenRouterFixture } from './openRouterFetch';

// Minimal buffers with the right magic numbers for format sniffing.
export const OGG_BYTES = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60, 1)]);
export const MP3_BYTES = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(61, 2)]);
export const TRANSCODED_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(29, 7)]);
export const MP4_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(52, 3)]);
export const MKV_BYTES = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.from('matroska'),
  Buffer.alloc(52),
]);

type Scripted<T> = T | Error | (() => T | Error);

function resolveScripted<T>(value: Scripted<T>): T {
  const resolved = typeof value === 'function' ? (value as () => T | Error)() : value;
  if (resolved instanceof Error) throw resolved;
  return resolved;
}

export type FakeTranscoderOptions = {
  probe?: Scripted<ProbeResult>;
  toMp3?: Scripted<{ data: Buffer; durationSecs?: number } | undefined>;
  sampleVideo?: Scripted<VideoSample>;
};

export type FakeTranscoder = MediaTranscoder & {
  calls: { probe: Buffer[]; toMp3: Array<{ input: Buffer; maxSeconds: number }>; sampleVideo: Buffer[] };
};

export function createFakeTranscoder(opts: FakeTranscoderOptions = {}): FakeTranscoder {
  const calls: FakeTranscoder['calls'] = { probe: [], toMp3: [], sampleVideo: [] };
  return {
    calls,
    async probe(input) {
      calls.probe.push(input);
      return resolveScripted(opts.probe ?? { hasAudio: true, hasVideo: false });
    },
    async toMp3(input, maxSeconds) {
      calls.toMp3.push({ input, maxSeconds });
      // An explicit `toMp3: undefined` scripts "no audio track".
      return resolveScripted('toMp3' in opts ? opts.toMp3 : { data: TRANSCODED_MP3 });
    },
    async sampleVideo(input) {
      calls.sampleVideo.push(input);
      return resolveScripted(opts.sampleVideo ?? { frames: [], audio: undefined });
    },
  };
}

/** A transcoder standing in for "ffmpeg is not installed". */
export function createMissingTranscoder(): FakeTranscoder {
  const missing = () => new Error('ffmpeg is not installed (spawn ENOENT)');
  return createFakeTranscoder({ probe: missing, toMp3: missing, sampleVideo: missing });
}

export type CapturedRequest = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

/** Serves `fixtures` in order (throws when exhausted) and records every request. */
export function createCapturingClient(fixtures: OpenRouterFixture[]): { client: OpenAI; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = async (url: unknown, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    requests.push({ url: String(url), body, headers });
    const fixture = fixtures[requests.length - 1];
    if (!fixture) throw new Error(`No fixture for request #${requests.length}`);
    return new Response(JSON.stringify(fixture.response), {
      status: fixture.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new OpenAI({
    apiKey: 'test-key',
    baseURL: 'https://openrouter.ai/api/v1',
    maxRetries: 0,
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
  });
  return { client, requests };
}

export type FakeFile = { body: Buffer; contentType?: string; status?: number; headers?: Record<string, string> };

/** A fetch serving `files` by exact URL (404 otherwise), recording the URLs asked for. */
export function createFileFetch(files: Record<string, FakeFile>): typeof globalThis.fetch & { urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    const file = files[url];
    if (!file) return new Response('not found', { status: 404 });
    const headers: Record<string, string> = { ...(file.headers ?? {}) };
    if (file.contentType) headers['content-type'] = file.contentType;
    return new Response(new Uint8Array(file.body), { status: file.status ?? 200, headers });
  };
  return Object.assign(fetchImpl as typeof globalThis.fetch, { urls });
}

/** The text parts and media parts of the user message in a captured media request. */
export function userContent(request: CapturedRequest): Array<Record<string, unknown>> {
  const messages = request.body.messages as Array<{ role: string; content: unknown }>;
  const user = messages.find((m) => m.role === 'user');
  return Array.isArray(user?.content) ? (user.content as Array<Record<string, unknown>>) : [];
}

export type FakeCatalog = Pick<ModelCatalog, 'info' | 'catalogInfo'>;

/**
 * A model catalog answering from a fixed table. Models missing from it are "unknown to the catalog":
 * catalogInfo() says undefined and info() falls back to Gemini-style defaults for google/gemini ids.
 */
export function createFakeCatalog(models: Record<string, { modalities: string[]; effort?: string }> = {}): FakeCatalog {
  const lookup = (model: string): ModelInfo | undefined => {
    const entry = models[model];
    return entry ? { inputModalities: new Set(entry.modalities), lowestEffort: entry.effort } : undefined;
  };
  return {
    async catalogInfo(model) {
      return lookup(model);
    },
    async info(model) {
      const known = lookup(model);
      if (known) return known;
      return model.startsWith('google/gemini')
        ? { inputModalities: new Set(['text', 'image', 'audio', 'video']) }
        : { inputModalities: new Set(['text']) };
    },
  };
}

/** Catalog entries matching OpenRouter's metadata for the models the media tests use (2026-09-25). */
export const CATALOG_MODELS = {
  'google/gemini-3.5-flash-lite': { modalities: ['text', 'image', 'video', 'file', 'audio'], effort: 'minimal' },
  'z-ai/glm-5.3-flash': { modalities: ['text', 'image', 'video'], effort: 'low' },
  'z-ai/glm-5.3': { modalities: ['text'], effort: 'low' },
  'qwen/qwen3-vl-235b-a22b-instruct': { modalities: ['text', 'image'] },
};
