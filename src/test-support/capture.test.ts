import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadErrorCapture, serializeError, writeErrorCapture } from '../ai/debugCapture';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'capture-test-'));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('writeErrorCapture / loadErrorCapture', () => {
  it('round-trips a capture through disk', () => {
    const dir = tempDir();
    vi.stubEnv('DEBUG_CAPTURE_DIR', dir);

    const filePath = writeErrorCapture({
      channelId: 'c1',
      model: 'm',
      error: new Error('test'),
      conversationEntries: [],
    });
    expect(filePath).toBeTruthy();

    const capture = loadErrorCapture(filePath as string);
    expect(capture.version).toBe(1);
    expect(capture.error.message).toBe('test');
    expect(capture.channelId).toBe('c1');
  });

  it('does nothing when DEBUG_CAPTURE is "0"', () => {
    const dir = tempDir();
    vi.stubEnv('DEBUG_CAPTURE_DIR', dir);
    vi.stubEnv('DEBUG_CAPTURE', '0');

    const result = writeErrorCapture({
      channelId: 'c1',
      model: 'm',
      error: new Error('test'),
      conversationEntries: [],
    });

    expect(result).toBeUndefined();
    // Disabled before the dir is created, so it stays empty.
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(files).toHaveLength(0);
  });

  it('prunes to at most 50 captures', () => {
    const dir = tempDir();
    vi.stubEnv('DEBUG_CAPTURE_DIR', dir);

    for (let i = 0; i < 55; i++) {
      writeErrorCapture({ channelId: `c${i}`, model: 'm', error: new Error(`err ${i}`), conversationEntries: [] });
    }

    const files = fs.readdirSync(dir).filter((f) => f.startsWith('error-') && f.endsWith('.json'));
    expect(files.length).toBeLessThanOrEqual(50);
  });

  it('throws when loading a capture with an unsupported version', () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'error-bad.json');
    const futureVersion: Record<string, unknown> = { version: 2, kind: 'capture' };
    fs.writeFileSync(filePath, JSON.stringify(futureVersion));
    expect(() => loadErrorCapture(filePath)).toThrow(/version/i);
  });
});

describe('serializeError', () => {
  it('captures message and stack for a plain Error', () => {
    const result = serializeError(new Error('boom'));
    expect(result.message).toBe('boom');
    expect(typeof result.stack).toBe('string');
  });

  it('captures status and errorBody from an APIError-style error', () => {
    const apiError = Object.assign(new Error('server error'), {
      status: 500,
      error: { message: 'Internal Server Error', code: 500 },
    });
    const result = serializeError(apiError);
    expect(result.status).toBe(500);
    expect(result.errorBody).toEqual({ message: 'Internal Server Error', code: 500 });
  });

  it('captures rawResponse when present', () => {
    const error = Object.assign(new Error('no choices'), { rawResponse: { error: { code: 502 } } });
    const result = serializeError(error);
    expect(result.rawResponse).toEqual({ error: { code: 502 } });
  });

  it('stringifies a non-Error value into the message', () => {
    const result = serializeError('just a string');
    expect(result.message).toBe('just a string');
  });
});
