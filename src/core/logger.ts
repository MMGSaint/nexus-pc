/**
 * Diagnostic logging. This is *not* the audit trail — audit records go through
 * the event log, which is hash chained and retained deliberately. This logger
 * is for operator troubleshooting and is safe to lose.
 */

import { redact, scrubString } from './redact.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

export interface LogRecord {
  readonly level: LogLevel;
  readonly component: string;
  readonly message: string;
  readonly fields?: Record<string, unknown>;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(component: string): Logger;
}

export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    this.records.push(record);
  }
}

export class StderrSink implements LogSink {
  write(record: LogRecord): void {
    const fields = record.fields ? ` ${JSON.stringify(redact(record.fields))}` : '';
    process.stderr.write(`[${record.level}] ${record.component}: ${scrubString(record.message)}${fields}\n`);
  }
}

export class NullSink implements LogSink {
  write(): void {
    /* intentionally silent */
  }
}

export function createLogger(sink: LogSink, minLevel: LogLevel = 'info', component = 'nexus'): Logger {
  const threshold = LEVEL_RANK[minLevel];

  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_RANK[level] < threshold) return;
    sink.write(
      fields === undefined
        ? { level, component, message: scrubString(message) }
        : { level, component, message: scrubString(message), fields: redact(fields) as Record<string, unknown> },
    );
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (child) => createLogger(sink, minLevel, `${component}.${child}`),
  };
}

export const silentLogger: Logger = createLogger(new NullSink(), 'error');
