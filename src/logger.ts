const getTimestamp = () => new Date().toISOString();

const log = (level: string, message: string, ...args: unknown[]) => {
  console.log(`[${getTimestamp()}] [${level.toUpperCase()}] ${message}`, ...args);
};

export const logger = {
  info: (message: string, ...args: unknown[]) => log('info', message, ...args),
  warn: (message: string, ...args: unknown[]) => log('warn', message, ...args),
  error: (message: string, ...args: unknown[]) => log('error', message, ...args),
  // Opt-in (LOG_DEBUG=1): for noisy diagnostics like per-search memory score distributions.
  debug: (message: string, ...args: unknown[]) => {
    if (process.env.LOG_DEBUG) log('debug', message, ...args);
  },
};
