/**
 * Range planning for directive compaction.
 *
 * Pure functions that decide WHAT to keep and WHAT to summarize from a
 * session's surface. The module takes a flat description of surface nodes —
 * never the `Session` object itself — so every decision is unit-testable
 * without mounting a session; the caller builds the node list from
 * `session.surface` and the event log.
 * @module @ya8d/dsh-directive-compact/plan
 */

/**
 * One surface node as the planner sees it. Built by the caller from the
 * session surface (type + source kind), keeping this module free of session
 * dependencies.
 */
export interface SurfaceNodeInfo {
  /** Event seq of the surface node (position in the ordered surface). */
  readonly seq: number
  /** One of the three message-producing surface event types. */
  readonly type: 'user/message' | 'assistant/message' | 'tool/result'
  /**
   * For `user/message`: the source kind (`user`, `agent-instructions`,
   * `skill-catalog`, or the plugin name for `plugin` sources). For other types
   * this is the type itself.
   */
  readonly kind: string
}

/** The plan a directive compaction should execute. */
export type CompactionPlan =
  | { readonly kind: 'none' }
  | {
    readonly kind: 'primary'
    /** Surface seqs preserved verbatim (fixed-skeleton head + kept head turns). */
    readonly headSeqs: readonly number[]
    /** Surface seqs replaced by one checkpoint message. */
    readonly middleSeqs: readonly number[]
    /** Surface seqs preserved verbatim after the summarized middle. */
    readonly tailSeqs: readonly number[]
  }

/**
 * How many user-utterance turns to preserve on each side of the middle span.
 * Mirrors the `DirectiveCompactConfig` subset the command layer passes in.
 */
export interface PlanConfig {
  /** Number of leading user utterances whose full turns are preserved (>= 1). */
  readonly keepHeadUsers: number
  /** Number of trailing user utterances whose full turns are preserved (>= 1). */
  readonly keepTailUsers: number
}

/**
 * Default head/tail budgets. The single source the command layer (P3) and
 * tests both use, so production defaults cannot drift from test expectations.
 */
export const DEFAULT_PLAN_CONFIG: PlanConfig = {
  keepHeadUsers: 3,
  keepTailUsers: 3,
}

/**
 * Whether a node is a genuine user utterance (not an injected system node).
 * @param node - the surface node to test.
 * @returns true when the node is a `user/message` whose source kind is `user`.
 */
export function isUserUtterance(node: SurfaceNodeInfo): boolean {
  return node.type === 'user/message' && node.kind === 'user'
}

/**
 * Index of the first user utterance — the end of the skeleton, where the
 * conversation begins. The skeleton is the leading injected system nodes
 * (including an older `compact` checkpoint after a previous compaction) that
 * precede the first user utterance; the user utterance itself starts the
 * conversation and serves as the first anchor.
 *
 * In a fresh session the user utterance is the first node, so the skeleton is
 * empty and the injected nodes that follow the user utterance belong to its
 * turn. After a prior compaction a `compact` checkpoint may precede the user
 * utterance and is part of the skeleton.
 * @param nodes - surface nodes in order.
 * @returns the index of the first user utterance; `nodes.length` when the
 *   surface has no user utterance at all.
 */
export function skeletonEndIndex(nodes: readonly SurfaceNodeInfo[]): number {
  const firstUser = nodes.findIndex(isUserUtterance)
  return firstUser === -1 ? nodes.length : firstUser
}

/**
 * Build the compaction plan for one directive-driven compaction.
 *
 * User utterances on the surface are the anchors. The skeleton (leading
 * injected nodes and a prior `compact` checkpoint before the first user) plus
 * the first `keepHeadUsers` user utterances' full turns form the head —
 * everything before the next user utterance after them, which is excluded. The
 * tail keeps everything from the `keepTailUsers`-from-last user utterance on,
 * including any in-flight assistant stream or unpaired tool call. The middle
 * between them is summarized. No-op when the middle is empty (fewer than
 * `keepHeadUsers + keepTailUsers` user utterances, or no user at all).
 *
 * Anchoring on surface user utterances — not on log `turn/start`/`turn/end`
 * markers — keeps repeated compaction correct: a prior compaction folds an
 * earlier span into a `compact` checkpoint node, so the log still carries the
 * old turn markers while the surface no longer has their content. Surface
 * anchors are what actually remain model-visible.
 *
 * Invariant: a `primary` plan's `tailSeqs` is non-empty and includes every
 * node from the `keepTailUsers`-from-last user utterance on; the middle never
 * splits an open tool pair (boundaries fall at user utterances, which are
 * balanced cuts).
 * @param nodes - surface nodes in order.
 * @param config - head/tail user-turn budgets.
 * @returns the plan to execute.
 */
export function planCompaction(
  nodes: readonly SurfaceNodeInfo[],
  config: PlanConfig,
): CompactionPlan {
  const skeletonEnd = skeletonEndIndex(nodes)
  const skeleton = nodes.slice(0, skeletonEnd)
  const conversation = nodes.slice(skeletonEnd)
  const userIndexes: number[] = []
  for (let index = 0; index < conversation.length; index += 1) {
    if (isUserUtterance(conversation[index]!)) userIndexes.push(index)
  }
  if (userIndexes.length <= config.keepHeadUsers + config.keepTailUsers) {
    return { kind: 'none' }
  }

  // Head: skeleton + the first keepHeadUsers user turns. The (keepHeadUsers)-th
  // user utterance (index keepHeadUsers) starts the middle and is excluded.
  const middleStart = userIndexes[config.keepHeadUsers]!
  // Tail: from the keepTailUsers-from-last user utterance on (inclusive).
  const tailStart = userIndexes[userIndexes.length - config.keepTailUsers]!

  const headSeqs = [...skeleton, ...conversation.slice(0, middleStart)].map(node => node.seq)
  const middleSeqs = conversation.slice(middleStart, tailStart).map(node => node.seq)
  const tailSeqs = conversation.slice(tailStart).map(node => node.seq)
  if (middleSeqs.length === 0) return { kind: 'none' }
  return { kind: 'primary', headSeqs, middleSeqs, tailSeqs }
}
