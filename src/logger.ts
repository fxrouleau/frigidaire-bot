import { format } from 'node:util';
import { config } from './config';
import { getLogFile } from './logFile';

const getTimestamp = () => new Date().toISOString();

const log = (level: string, message: string, ...args: unknown[]) => {
  const line = `[${getTimestamp()}] [${level.toUpperCase()}] ${message}`;
  console.log(line, ...args);
  // The same text console.log printed (util.format is what it uses), into the rotated file in the data
  // volume so it outlives the container (src/logFile.ts). The sink never throws; the guard is for the
  // formatting of exotic arguments.
  try {
    getLogFile()?.write(`${format(line, ...args)}\n`);
  } catch (error) {
    console.error('[logFile] could not format a log line:', error);
  }
};

export const logger = {
  info: (message: string, ...args: unknown[]) => log('info', message, ...args),
  warn: (message: string, ...args: unknown[]) => log('warn', message, ...args),
  error: (message: string, ...args: unknown[]) => log('error', message, ...args),
  // Opt-in (LOG_DEBUG=1): for noisy diagnostics like per-search memory score distributions.
  debug: (message: string, ...args: unknown[]) => {
    if (config.logging.debug) log('debug', message, ...args);
  },
};
