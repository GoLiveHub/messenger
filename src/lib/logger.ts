/**
 * Structured logger with pino fallback.
 *
 * If pino is available, uses it for JSON logging.
 * Otherwise, creates a simple console-based structured logger.
 */

interface LogFn {
  (msg: string, extra?: Record<string, unknown>): void;
}

interface Logger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
  suspicious: LogFn;
  child(bindings: Record<string, unknown>): Logger;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function outputJson(level: string, msg: string, extra?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    level,
    time: formatTimestamp(),
    msg,
  };
  if (extra) Object.assign(entry, extra);
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

class ConsoleLogger implements Logger {
  private bindings: Record<string, unknown>;

  constructor(bindings: Record<string, unknown> = {}) {
    this.bindings = bindings;
  }

  private emit(level: string, msg: string, extra?: Record<string, unknown>): void {
    outputJson(level, msg, { ...this.bindings, ...extra });
  }

  info(msg: string, extra?: Record<string, unknown>): void {
    this.emit('info', msg, extra);
  }

  warn(msg: string, extra?: Record<string, unknown>): void {
    this.emit('warn', msg, extra);
  }

  error(msg: string, extra?: Record<string, unknown>): void {
    this.emit('error', msg, extra);
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    this.emit('debug', msg, extra);
  }

  suspicious(msg: string, extra?: Record<string, unknown>): void {
    this.emit('warn', msg, { ...extra, security: true });
  }

  child(bindings: Record<string, unknown>): Logger {
    return new ConsoleLogger({ ...this.bindings, ...bindings });
  }
}

function createLogger(): Logger {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pinoModule = require('pino') as any;
    const pino = pinoModule?.default ?? pinoModule;
    if (typeof pino !== 'function') return new ConsoleLogger();
    const level = process.env.LOG_LEVEL || 'info';
    const logger = pino({ level });
    const levels: Record<string, string> = {
      info: 'info',
      warn: 'warn',
      error: 'error',
      debug: 'debug',
    };

    const pinoLogger: Logger = {
      info: (msg: string, extra?: Record<string, unknown>) => logger.info(extra ?? {}, msg),
      warn: (msg: string, extra?: Record<string, unknown>) => logger.warn(extra ?? {}, msg),
      error: (msg: string, extra?: Record<string, unknown>) => logger.error(extra ?? {}, msg),
      debug: (msg: string, extra?: Record<string, unknown>) => logger.debug(extra ?? {}, msg),
      suspicious: (msg: string, extra?: Record<string, unknown>) => logger.warn({ ...extra, security: true }, msg),
      child(bindings: Record<string, unknown>): Logger {
        const child = logger.child(bindings);
        return {
          info: (msg, extra) => child.info(extra ?? {}, msg),
          warn: (msg, extra) => child.warn(extra ?? {}, msg),
          error: (msg, extra) => child.error(extra ?? {}, msg),
          debug: (msg, extra) => child.debug(extra ?? {}, msg),
          suspicious: (msg, extra) => child.warn({ ...extra, security: true }, msg),
          child: pinoLogger.child,
        };
      },
    };
    return pinoLogger;
  } catch {
    return new ConsoleLogger();
  }
}

export const log = createLogger();
