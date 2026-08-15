/**
 * Package-owned invariant companion for `@ya8d/dsh-directive-compact`.
 * @module @ya8d/dsh-directive-compact/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@ya8d/dsh-directive-compact'

/** Cordis companion plugin name. */
export const name = 'dsh-directive-compact-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns no independent event stream or
 * mutable relationship beyond what it shares with the compaction seam's own
 * events (`compaction/start`/`summary`/`end`) and the session log itself, which
 * the seam and session packages already validate. The directive text and its
 * before/after trace ride those existing records; the REAL-composition and
 * loop tests pin that reconstructability instead.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
