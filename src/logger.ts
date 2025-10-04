const getTimestamp = () => new Date().toISOString();

const log = (level: string, message: string, ...args: unknown[]) => {
  console.log(`[${getTimestamp()}] [${level.toUpperCase()}] ${message}`, ...args);
};

export const logger = {
  info: (message: string, ...args: unknown[]) => log('info', message, ...args),
  warn: (message: string, ...args: unknown[]) => log('warn', message, ...args),
  error: (message: string, ...args: unknown[]) => log('error', message, ...args),
};
