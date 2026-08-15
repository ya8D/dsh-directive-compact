/**
 * Pure-incremental directive-driven compaction for DeepSeek Harness.
 *
 * Registers `/compact-directive <requirement>`: a global command that keeps the
 * session's fixed head (first user message + the injected agent-instructions /
 * system-prompt / skill-catalog nodes) and the recent turns, while summarizing
 * the middle span per the user's natural-language requirement. It does not
 * inherit `BasicCompactionEngine` and never registers `ctx.compaction`, so it
 * coexists with the upstream compaction backend unchanged.
 * @module @ya8d/dsh-directive-compact
 */

import type { Context } from '@deepseek-ai/cordis'

/** Function-plugin entry name (no default export; the Loader drops it otherwise). */
export const name = 'dsh-directive-compact'

/** Services the command needs: command registry plus the session/message seam. */
export const inject = ['commands', 'sessions']

/**
 * Register the plugin. P0 scaffold: real command registration lands in P4.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  void ctx
}
