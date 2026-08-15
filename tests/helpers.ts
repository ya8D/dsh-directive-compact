/**
 * Shared test helpers: a Cordis-logger stub that records every message.
 *
 * The commands log through `ctx.logger('dsh-directive-compact')` (named
 * facade) and through `ctx.logger.<level>(...)` (service-level methods); the
 * stub must serve both shapes and collect all records for assertions.
 * @module tests/helpers
 */

import type { Context } from '@deepseek-ai/cordis'

/** One recorded log call. */
export interface LogRecord {
  readonly level: 'info' | 'warn' | 'debug' | 'error'
  readonly args: readonly unknown[]
}

/** A callable logger stub plus the records it collected. */
export interface LoggerStub {
  /** Drop-in for `Context['logger']`: callable and method-bearing. */
  readonly logger: Context['logger']
  /** Every log call in order, from both the named-facade and service shapes. */
  readonly records: LogRecord[]
}

/**
 * Build a logger stub that records every call. The named facade returned by
 * `ctx.logger(name)` and the service-level `ctx.logger.info(...)` methods both
 * funnel into the same `records` array.
 * @returns the stub and its collected records.
 */
export function createLoggerStub(): LoggerStub {
  const records: LogRecord[] = []
  const makeMethod = (level: LogRecord['level']) => (...args: unknown[]): void => {
    records.push({ level, args })
  }
  const facade = {
    info: makeMethod('info'),
    warn: makeMethod('warn'),
    debug: makeMethod('debug'),
    error: makeMethod('error'),
  }
  const logger = Object.assign((() => facade) as unknown as Context['logger'], {
    info: makeMethod('info'),
    warn: makeMethod('warn'),
    debug: makeMethod('debug'),
    error: makeMethod('error'),
  })
  return { logger, records }
}
