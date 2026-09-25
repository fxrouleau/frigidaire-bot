// A size-rotated log file in the data volume (LOG_FILE, default ./data/logs/bot.log), so the logs of the
// previous container survive a redeploy: watchtower recreates the container on every image update, and
// that wipes `docker logs`.
//
// Writes are synchronous appends to an open descriptor: log lines stay in order, and the last lines
// before a crash are on disk (which is the point of keeping them). At the bot's log volume that costs
// microseconds per line. Rotation is by size: bot.log → bot.log.1 → … → bot.log.<maxFiles-1>, the oldest
// dropped.
//
// Nothing here may ever break the bot: every filesystem error is caught, reported once on the console,
// and the file log pauses for a minute before trying again (a full disk or a permissions problem heals
// without a restart). This module deliberately does not import the logger (the logger imports it).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from './config';

export type RotatingFileLogOptions = {
  /** Rotate before a write would take the current file past this size. */
  maxBytes: number;
  /** Files kept in total, the current one included (1 ⇒ the file is truncated instead of rotated). */
  maxFiles: number;
  /** After a filesystem error, how long to stay quiet before trying again (default 60 s). */
  retryAfterMs?: number;
  now?: () => number;
  /** Where the sink reports its own problems (default: console.error). */
  report?: (message: string) => void;
};

const DEFAULT_RETRY_AFTER_MS = 60 * 1000;

export class RotatingFileLog {
  readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;
  private readonly report: (message: string) => void;
  private fd: number | undefined;
  private size = 0;
  private pausedUntil = 0;
  private failing = false;

  constructor(filePath: string, opts: RotatingFileLogOptions) {
    this.filePath = path.resolve(filePath);
    this.maxBytes = Math.max(1, opts.maxBytes);
    this.maxFiles = Math.max(1, Math.floor(opts.maxFiles));
    this.retryAfterMs = opts.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    this.now = opts.now ?? Date.now;
    this.report = opts.report ?? ((message) => console.error(message));
  }

  /** Appends `text` (callers include the trailing newline). Never throws. */
  write(text: string): void {
    if (this.now() < this.pausedUntil) return;
    try {
      const bytes = Buffer.byteLength(text);
      if (this.fd === undefined) this.open();
      // A line longer than the limit still goes out, into a fresh file.
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      if (this.fd === undefined) return;
      fs.writeSync(this.fd, text);
      this.size += bytes;
      if (this.failing) {
        this.failing = false;
        this.report(`[logFile] writing to ${this.filePath} again.`);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  close(): void {
    if (this.fd === undefined) return;
    const fd = this.fd;
    this.fd = undefined;
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed or the disk vanished; there is nothing left to release.
    }
  }

  private open(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const fd = fs.openSync(this.filePath, 'a');
    try {
      this.size = fs.fstatSync(fd).size;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
    this.fd = fd;
  }

  private rotate(): void {
    this.close();
    if (this.maxFiles <= 1) {
      fs.truncateSync(this.filePath, 0);
    } else {
      // Shift oldest first so nothing is overwritten before it has moved; renameSync replaces the
      // oldest backup, which is the one being dropped.
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.filePath}.${i}`);
      }
    }
    this.open();
  }

  private fail(error: unknown): void {
    this.close();
    this.pausedUntil = this.now() + this.retryAfterMs;
    // One report per failure streak, not one per log line.
    if (this.failing) return;
    this.failing = true;
    const reason = error instanceof Error ? error.message : String(error);
    this.report(
      `[logFile] cannot write ${this.filePath} (${reason}); console logging continues, retrying in ${Math.round(this.retryAfterMs / 1000)} s.`,
    );
  }
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Number(mb.toFixed(1))} MB` : `${Math.round(bytes / 1024)} KB`;
}

let active: { key: string; log: RotatingFileLog } | undefined;
let override: { log: RotatingFileLog | undefined } | undefined;

/**
 * The process-wide file log for the current configuration, or undefined when it is off (LOG_FILE=off)
 * or inside Vitest (tests never write under ./data). Rebuilt if the settings change.
 */
export function getLogFile(): RotatingFileLog | undefined {
  if (override) return override.log;
  const filePath = config.logging.file;
  if (!filePath || config.isTest) {
    active?.log.close();
    active = undefined;
    return undefined;
  }
  const maxBytes = config.logging.fileMaxBytes;
  const maxFiles = config.logging.fileMaxFiles;
  const key = JSON.stringify([filePath, maxBytes, maxFiles]);
  if (active?.key !== key) {
    active?.log.close();
    const log = new RotatingFileLog(filePath, { maxBytes, maxFiles });
    active = { key, log };
    // Marks where each process's lines begin (one container's run ends where the next one starts).
    const line = `[${new Date().toISOString()}] [INFO] File log ${log.filePath} opened by pid ${process.pid} (rotates at ${formatBytes(maxBytes)}, keeps ${maxFiles} file${maxFiles === 1 ? '' : 's'}).`;
    console.log(line);
    log.write(`${line}\n`);
  }
  return active.log;
}

/** Tests: route the logger's file output to `log` (undefined ⇒ none); call with no argument to reset. */
export function setLogFileForTesting(...args: [RotatingFileLog | undefined] | []): void {
  override = args.length === 0 ? undefined : { log: args[0] };
}
