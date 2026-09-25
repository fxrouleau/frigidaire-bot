import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from './config';
import { RotatingFileLog, getLogFile, setLogFileForTesting } from './logFile';
import { logger } from './logger';

let dir: string;
let file: string;
let reports: string[];

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

function sink(opts: Partial<ConstructorParameters<typeof RotatingFileLog>[1]> = {}): RotatingFileLog {
  return new RotatingFileLog(file, { maxBytes: 100, maxFiles: 3, report: (m) => reports.push(m), ...opts });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logfile-test-'));
  file = path.join(dir, 'logs', 'bot.log');
  reports = [];
});

afterEach(() => {
  setLogFileForTesting();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('RotatingFileLog', () => {
  it('creates the directory and appends, keeping what an earlier process wrote', () => {
    const first = sink();
    first.write('one\n');
    first.close();

    const second = sink();
    second.write('two\n');
    second.close();

    expect(read(file)).toBe('one\ntwo\n');
  });

  it('rotates by size: bot.log → bot.log.1 → bot.log.2, dropping the oldest', () => {
    const log = sink({ maxBytes: 10 });
    for (const line of ['aaaaaaaa\n', 'bbbbbbbb\n', 'cccccccc\n', 'dddddddd\n']) log.write(line);
    log.close();

    expect(read(file)).toBe('dddddddd\n');
    expect(read(`${file}.1`)).toBe('cccccccc\n');
    expect(read(`${file}.2`)).toBe('bbbbbbbb\n');
    expect(fs.existsSync(`${file}.3`)).toBe(false);
  });

  it('counts the size already on disk when it reopens a file', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(95));

    const log = sink();
    log.write('this pushes it past 100 bytes\n');
    log.close();

    expect(read(`${file}.1`)).toBe('x'.repeat(95));
    expect(read(file)).toBe('this pushes it past 100 bytes\n');
  });

  it('writes a line longer than the limit whole, into a fresh file', () => {
    const log = sink({ maxBytes: 10 });
    log.write('short\n');
    log.write(`${'y'.repeat(50)}\n`);
    log.close();

    expect(read(file)).toBe(`${'y'.repeat(50)}\n`);
    expect(read(`${file}.1`)).toBe('short\n');
  });

  it('truncates instead of rotating when only one file is kept', () => {
    const log = sink({ maxBytes: 10, maxFiles: 1 });
    log.write('aaaaaaaa\n');
    log.write('bbbbbbbb\n');
    log.close();

    expect(read(file)).toBe('bbbbbbbb\n');
    expect(fs.existsSync(`${file}.1`)).toBe(false);
  });

  it('never throws on a filesystem error, reports it once, pauses, then recovers', () => {
    let now = 1_000;
    // The log path is a directory, so opening it fails until the directory is replaced.
    fs.mkdirSync(file, { recursive: true });
    const log = sink({ now: () => now, retryAfterMs: 60_000 });

    expect(() => log.write('lost 1\n')).not.toThrow();
    expect(() => log.write('lost 2\n')).not.toThrow();
    now += 61_000;
    log.write('lost 3\n');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/^\[logFile\] cannot write .*bot\.log .*retrying in 60 s\.$/);

    fs.rmSync(file, { recursive: true });
    log.write('still paused\n');
    now += 61_000;
    log.write('back\n');
    log.close();

    expect(read(file)).toBe('back\n');
    expect(reports[1]).toContain('writing to');
  });
});

describe('config.logging file settings', () => {
  it('defaults to ./data/logs/bot.log, 5 MB × 3 files', () => {
    vi.stubEnv('LOG_FILE', '');
    vi.stubEnv('LOG_FILE_MAX_BYTES', '');
    vi.stubEnv('LOG_FILE_MAX_FILES', '');
    expect(config.logging.file).toBe('./data/logs/bot.log');
    expect(config.logging.fileMaxBytes).toBe(5 * 1024 * 1024);
    expect(config.logging.fileMaxFiles).toBe(3);
  });

  it('accepts a custom path, turns off with off/false/0/no/none, and ignores out-of-range sizes', () => {
    vi.stubEnv('LOG_FILE', '/var/log/frigidaire.log');
    expect(config.logging.file).toBe('/var/log/frigidaire.log');
    for (const off of ['off', 'OFF', 'false', '0', 'no', 'none']) {
      vi.stubEnv('LOG_FILE', off);
      expect(config.logging.file).toBeUndefined();
    }
    vi.stubEnv('LOG_FILE_MAX_BYTES', '10');
    vi.stubEnv('LOG_FILE_MAX_FILES', '0');
    expect(config.logging.fileMaxBytes).toBe(5 * 1024 * 1024);
    expect(config.logging.fileMaxFiles).toBe(3);
  });
});

describe('getLogFile / logger wiring', () => {
  it('is off inside Vitest even when LOG_FILE is set, so tests never write under ./data', () => {
    vi.stubEnv('LOG_FILE', file);
    expect(getLogFile()).toBeUndefined();
  });

  it('sends every logger line to the file with the same text as the console, args formatted', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = sink({ maxBytes: 10_000 });
    setLogFileForTesting(log);

    logger.info('hello %s', 'world');
    logger.warn('count:', 3, { a: 1 });
    logger.error('boom:', new Error('kaput'));
    log.close();

    const lines = read(file).split('\n');
    expect(lines[0]).toMatch(/^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] \[INFO\] hello world$/);
    expect(lines[1]).toMatch(/\[WARN\] count: 3 \{ a: 1 \}$/);
    expect(lines[2]).toMatch(/\[ERROR\] boom: Error: kaput$/);
    expect(lines[3]).toMatch(/^\s+at /); // the stack trace, as on the console
  });

  it('keeps logging to the console when the file cannot be written', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    fs.mkdirSync(file, { recursive: true });
    setLogFileForTesting(sink());

    expect(() => logger.info('still visible')).not.toThrow();
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('[INFO] still visible'));
    expect(reports).toHaveLength(1);
  });
});
