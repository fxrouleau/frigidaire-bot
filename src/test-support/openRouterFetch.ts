// HTTP-level record/replay for the OpenAI SDK client. The SDK accepts a custom `fetch` in its
// constructor; we hand it one that serves a recorded fixture instead of hitting the network.
import * as fs from 'node:fs';
import * as path from 'node:path';
import OpenAI from 'openai';

export type OpenRouterFixture = {
  version: 1;
  description?: string;
  status: number;
  /** Optional: the request body this fixture expects (for documentation; not matched strictly). */
  request?: unknown;
  /** The raw JSON body OpenRouter returns (an OpenAI ChatCompletion shape, or an error envelope). */
  response: unknown;
};

export const FIXTURES_DIR: string = path.join(__dirname, 'fixtures', 'openrouter');

export function loadFixture(name: string): OpenRouterFixture {
  const fileName = name.endsWith('.json') ? name : `${name}.json`;
  const filePath = path.join(FIXTURES_DIR, fileName);
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as OpenRouterFixture;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported fixture version in ${fileName}: ${(parsed as { version?: unknown }).version}`);
  }
  return parsed;
}

function parseBody(init?: unknown): unknown {
  if (!init || typeof init !== 'object') return undefined;
  const body = (init as { body?: unknown }).body;
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function jsonResponse(fixture: OpenRouterFixture): Response {
  return new Response(JSON.stringify(fixture.response), {
    status: fixture.status,
    headers: { 'content-type': 'application/json' },
  });
}

export function createReplayFetch(
  fixture: OpenRouterFixture,
  onRequest?: (body: unknown) => void,
): (url: unknown, init?: unknown) => Promise<Response> {
  return async (_url: unknown, init?: unknown): Promise<Response> => {
    if (onRequest) {
      onRequest(parseBody(init));
    }
    return jsonResponse(fixture);
  };
}

export function createReplayClient(fixture: OpenRouterFixture, onRequest?: (body: unknown) => void): OpenAI {
  return new OpenAI({
    apiKey: 'test-key',
    baseURL: 'https://openrouter.ai/api/v1',
    maxRetries: 0,
    // The SDK's `fetch` option expects a global-fetch-shaped function; our replay fetch is
    // intentionally loosely typed, so bridge it with a narrow documented cast.
    fetch: createReplayFetch(fixture, onRequest) as unknown as typeof globalThis.fetch,
  });
}

export function createSequenceReplayClient(
  fixtures: OpenRouterFixture[],
  onRequest?: (body: unknown, index: number) => void,
): OpenAI {
  let index = 0;
  const replayFetch = async (_url: unknown, init?: unknown): Promise<Response> => {
    const current = fixtures[index];
    if (!current) {
      throw new Error(`Replay sequence exhausted: request #${index + 1} but only ${fixtures.length} fixtures provided`);
    }
    if (onRequest) {
      onRequest(parseBody(init), index);
    }
    index += 1;
    return jsonResponse(current);
  };

  return new OpenAI({
    apiKey: 'test-key',
    baseURL: 'https://openrouter.ai/api/v1',
    maxRetries: 0,
    fetch: replayFetch as unknown as typeof globalThis.fetch,
  });
}

export function createRecordingClient(opts: { outPath: string; apiKey: string }): OpenAI {
  const recordingFetch = async (url: unknown, init?: unknown): Promise<Response> => {
    const request = parseBody(init);
    const response = await globalThis.fetch(url as Parameters<typeof globalThis.fetch>[0], init as RequestInit);
    const status = response.status;
    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      body = await response.clone().text();
    }
    const fixture: OpenRouterFixture = { version: 1, status, request, response: body };
    fs.writeFileSync(opts.outPath, JSON.stringify(fixture, null, 2));
    return response;
  };

  return new OpenAI({
    apiKey: opts.apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: { 'X-Title': 'Frigidaire Bot' },
    maxRetries: 0,
    fetch: recordingFetch as unknown as typeof globalThis.fetch,
  });
}
