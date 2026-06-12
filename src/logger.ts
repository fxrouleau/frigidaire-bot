const getTimestamp = () => new Date().toISOString();

const log = (level: string, message: string, ...args: unknown[]) => {
  console.log(`[${getTimestamp()}] [${level.toUpperCase()}] ${message}`, ...args);
};

export const logger = {
  info: (message: string, ...args: unknown[]) => log('info', message, ...args),
  warn: (message: string, ...args: unknown[]) => log('warn', message, ...args),
  error: (message: string, ...args: unknown[]) => log('error', message, ...args),
  // Opt-in (LOG_DEBUG=1): for noisy diagnostics like per-search memory score distributions.
  // '0'/'false' disable it explicitly, matching the DEBUG_CAPTURE / SEMANTIC_MEMORY_ENABLED convention.
  debug: (message: string, ...args: unknown[]) => {
    const flag = process.env.LOG_DEBUG;
    if (flag && flag !== '0' && flag !== 'false') log('debug', message, ...args);
  },
};
