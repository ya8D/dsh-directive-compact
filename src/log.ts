/**
 * Shared logging helpers for the two command transactions.
 *
 * Both commands log through the Cordis logger service under the plugin's own
 * scope (`ctx.logger('dsh-directive-compact')`), matching the upstream
 * convention: `compaction-basic` reports its results through `ctx.logger.info`
 * and failures through `ctx.logger.warn`. Levels: `info` for phase milestones
 * and per-chunk timings (visible at the default console threshold), `debug`
 * for input geometry and call internals (hidden unless the exporter raises the
 * plugin's level above INFO), `warn` for retries and failures.
 * @module @ya8d/dsh-directive-compact/log
 */

/** Max directive characters written to a log line. */
const MAX_LOGGED_DIRECTIVE = 120

/**
 * Shorten a directive for log lines. A directive is user prose and can be
 * enormous; the log only needs its intent to correlate a run.
 * @param directive - the user's requirement.
 * @returns the directive, truncated to {@link MAX_LOGGED_DIRECTIVE} chars.
 */
export function shortDirective(directive: string): string {
  return directive.length <= MAX_LOGGED_DIRECTIVE
    ? directive
    : `${directive.slice(0, MAX_LOGGED_DIRECTIVE)}…`
}
