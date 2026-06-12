// Captures failed AI exchanges to disk so they can be replayed locally (yarn replay <file>).
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../logger';
import type { ConversationEntry } from './types';

export type CapturedError = {
  message: string;
  stack?: string;
  status?: number;
  errorBody?: unknown;
  rawResponse?: unknown;
};

export type ErrorCapture = {
  version: 1;
  kind: 'capture';
  timestamp: string;
  channelId: string;
  model: string;
  error: CapturedError;
  conversationEntries: ConversationEntry[];
  thoughts?: unknown;
};

export const MAX_CAPTURES = 50;

export function serializeError(error: unknown): CapturedError {
  if (error instanceof Error) {
    const candidate = error as Error & { status?: unknown; error?: unknown; rawResponse?: unknown };
    const result: CapturedError = { message: error.message };
    if (error.stack) {
      result.stack = error.stack;
    }
    if (typeof candidate.status === 'number') {
      result.status = candidate.status;
    }
    if (candidate.error !== undefined) {
      result.errorBody = candidate.error;
    }
    if (candidate.rawResponse !== undefined) {
      result.rawResponse = candidate.rawResponse;
    }
    return result;
  }

  // Non-Error values (objects, strings, etc). Still try to lift the OpenAI APIError-style fields.
  const candidate = error as { status?: unknown; error?: unknown; rawResponse?: unknown } | null | undefined;
  const result: CapturedError = { message: String(error) };
  if (candidate && typeof candidate === 'object') {
    if (typeof candidate.status === 'number') {
      result.status = candidate.status;
    }
    if (candidate.error !== undefined) {
      result.errorBody = candidate.error;
    }
    if (candidate.rawResponse !== undefined) {
      result.rawResponse = candidate.rawResponse;
    }
  }
  return result;
}

export function writeErrorCapture(input: {
  channelId: string;
  model: string;
  error: unknown;
  conversationEntries: ConversationEntry[];
  thoughts?: unknown;
}): string | undefined {
  if (process.env.DEBUG_CAPTURE === '0') {
    return undefined;
  }

  try {
    const dir = process.env.DEBUG_CAPTURE_DIR || './data/debug';
    fs.mkdirSync(dir, { recursive: true });

    const capture: ErrorCapture = {
      version: 1,
      kind: 'capture',
      timestamp: new Date().toISOString(),
      channelId: input.channelId,
      model: input.model,
      error: serializeError(input.error),
      conversationEntries: input.conversationEntries,
      thoughts: input.thoughts,
    };

    // A short random suffix guarantees uniqueness: the ISO timestamp only has millisecond
    // resolution, so rapid (or same-tick) captures would otherwise overwrite each other.
    const suffix = crypto.randomBytes(3).toString('hex');
    const fileName = `error-${new Date().toISOString().replace(/[:.]/g, '-')}-${suffix}.json`;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(capture, null, 2));

    pruneCaptures(dir);

    return filePath;
  } catch (error) {
    logger.warn('Failed to write error capture:', error);
    return undefined;
  }
}

function pruneCaptures(dir: string): void {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('error-') && name.endsWith('.json'))
    .sort()
    .reverse();

  for (const stale of files.slice(MAX_CAPTURES)) {
    fs.rmSync(path.join(dir, stale), { force: true });
  }
}

export function loadErrorCapture(filePath: string): ErrorCapture {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as ErrorCapture;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported error capture version: ${(parsed as { version?: unknown }).version}`);
  }
  return parsed;
}
