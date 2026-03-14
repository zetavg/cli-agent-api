import { randomUUID } from 'node:crypto';

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'error';
  event: string;
  message: string;
  [key: string]: unknown;
}

export function writeLog(entry: Omit<LogEntry, 'timestamp'>): void {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
  );
}

export function createRequestLogContext() {
  return {
    requestId: randomUUID(),
    startedAt: process.hrtime.bigint(),
  };
}

export function durationMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

export function formatDurationMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

export function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: serializeErrorCause(error.cause),
    };
  }

  return {
    message: String(error),
  };
}

function serializeErrorCause(cause: unknown) {
  if (!(cause instanceof Error)) {
    return cause === undefined ? undefined : { message: String(cause) };
  }

  return {
    name: cause.name,
    message: cause.message,
    stack: cause.stack,
  };
}
