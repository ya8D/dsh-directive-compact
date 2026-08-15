/**
 * Free-trim prompt planning for `/trim-directive <requirement>`.
 *
 * The trim hands the ENTIRE current surface to the model and lets the user's
 * natural-language requirement decide what survives — no head, no tail, no
 * region protection. This module builds the directive-only prompt (the
 * ContextForge `compact_by_directive` shape): the user's requirement is the
 * sole instruction, layered over no summarization baseline, so a requirement
 * like "delete everything about doc, keep only the login flow" is honored
 * directly rather than filtered through a four-point summary contract.
 * @module @ya8d/dsh-directive-compact/trim
 */

/**
 * Directive-only trim instruction. Unlike the compact-directive baseline, no
 * "keep task goal / findings / next step" floor is imposed: the trim is the
 * user's explicit request to cut, and the model obeys it. The final
 * requirement line and the rendered history follow this prefix.
 */
export const TRIM_INSTRUCTION =
  'Below is the current conversation context of an AI agent. Apply the user\'s trim requirement EXACTLY: delete what it asks to delete, keep what it asks to keep, and rewrite nothing that is kept. Output only the trimmed context — the user\'s own words must survive verbatim where kept. No pleasantries, no commentary, no tools. Here is the requirement:\n\n'

/**
 * Build the trim prompt for one call: the requirement verbatim, then the
 * rendered history. The requirement is never summarized or normalized — the
 * user's phrasing is the instruction.
 * @param directive - the user's trim requirement; the command layer rejects an
 *   empty input before this is called, so `undefined` here is unreachable and
 *   fails loud rather than trimming with an empty instruction.
 * @returns the prompt prefix the rendered surface is appended to.
 */
export function buildTrimPrompt(directive: string | undefined): string {
  if (directive === undefined || directive.length === 0) {
    throw new Error('directive trim requires a non-empty requirement')
  }
  return `${TRIM_INSTRUCTION}${directive}\n\nHere is the context:\n\n`
}

/** Marker naming the directive, prepended to the landed trim checkpoint. */
export function trimMarker(directive: string): string {
  return `[Directive trim, per requirement: ${directive}]`
}

/**
 * Fixed per-chunk input cap (heuristic tokens; the meter prices ~4 chars/token,
 * so ≈200K rendered chars per chunk). The plugin targets the 1M-window
 * DeepSeek models. 50K keeps one summarization call fast and independently
 * retriable, where a single ~200K-token call can take 10+ minutes or hang
 * (observed on a real 178K-token session).
 */
const TRIM_CHUNK_INPUT_BUDGET = 50_000

/** Hard cap on chunk count: 20 × 50K = 1M = the full 1M window. */
const TRIM_MAX_CHUNKS = 20

/** One token-priced surface node, as the chunker slices on. */
export interface PricedTrimNode {
  /** Event seq of the surface node. */
  readonly seq: number
  /** Heuristic tokens for the exact message this node projects (token-meter). */
  readonly tokens: number
}

/** Budget constants for one trim summarization call. */
export interface TrimBudget {
  /** Per-call output cap: min(contextWindow/2, adapter max output tokens). */
  readonly maxTokens: number
  /** Per-chunk input cap: fixed 50K heuristic tokens (targets the 1M window). */
  readonly chunkInputBudget: number
  /** Hard cap on chunk count: 20 × 50K = 1M = the 1M window. */
  readonly maxChunks: number
}

/**
 * Resolve the summarization budget for the trim.
 *
 * The plugin targets the 1M-window DeepSeek models (adapter per-response cap
 * 256K), so every number is fixed rather than window-derived:
 * - output cap = 256K per call — half the 1M window, equal to the adapter's
 *   hard per-response limit; reasoning tokens count toward this cap, so the
 *   model's thinking shares it with the visible output;
 * - per-chunk input = 50K heuristic tokens (~200K rendered chars) — small
 *   enough that one call completes quickly and is independently retriable,
 *   where a ~200K-token single call can take 10+ minutes or hang;
 * - max chunks = 20 — 20 × 50K = 1M, the full window; more chunks would mean
 *   total input > window, which the model cannot read anyway. `chunkTrimNodes`
 *   fails loud beyond this bound ("compact the session first").
 *
 * The output cap is per chunk and there is NO cross-chunk aggregate cap: N
 * chunks could theoretically emit N × 256K of output. The whole assembled
 * checkpoint is what lands, and the shrink validation in `executeTrim`
 * (checkpoint must be smaller than the shadowed span) bounds the real total
 * output to the shadowed size regardless of chunk count — a model that fills
 * every chunk's cap simply cannot pass it.
 * @param contextWindow - routed model's combined request+response capacity.
 * @param adapterMaxTokens - adapter's hard per-response output cap.
 * @returns the budget for one chunked trim.
 */
export function resolveTrimBudget(
  contextWindow: number,
  adapterMaxTokens: number,
): TrimBudget {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error(`directive trim: invalid context window ${contextWindow}`)
  }
  if (!Number.isSafeInteger(adapterMaxTokens) || adapterMaxTokens <= 0) {
    throw new Error(`directive trim: invalid adapter max tokens ${adapterMaxTokens}`)
  }
  return {
    maxTokens: Math.min(Math.floor(contextWindow / 2), adapterMaxTokens),
    chunkInputBudget: TRIM_CHUNK_INPUT_BUDGET,
    maxChunks: TRIM_MAX_CHUNKS,
  }
}

/** One chunk of the trim input: a contiguous run of surface seqs. */
export interface TrimChunk {
  /** Surface seqs of the chunk, in surface order. */
  readonly seqs: readonly number[]
  /** Sum of heuristic tokens over the chunk's nodes. */
  readonly tokens: number
}

/**
 * Slice the priced surface nodes into budget-sized chunks.
 *
 * Tokens accumulate per node; when the running total reaches the per-chunk
 * input budget, a cut is made — but the cut rolls BACK to the nearest balanced
 * boundary (`isBalancedBefore(node)` true) so a tool-call/result pair is never
 * split, mirroring the upstream `selectCompactableRange` balance loop. A chunk
 * may exceed the nominal budget when a single node is larger than it (the
 * node cannot be split); `maxChunks` guards runaway fragmentation.
 * @param nodes - token-priced surface nodes in order.
 * @param budget - per-chunk input cap.
 * @param isBalancedBefore - reports whether the cut before a node is
 *   tool-pairing balanced (injected by the caller from the session).
 * @returns the chunks, in surface order.
 * @throws when the total input exceeds `maxChunks` worth of budget — the
 *   session exceeds the window and must be compacted before trimming.
 */
export function chunkTrimNodes(
  nodes: readonly PricedTrimNode[],
  budget: TrimBudget,
  isBalancedBefore: (node: PricedTrimNode) => boolean,
): TrimChunk[] {
  if (nodes.length === 0) return []
  const maxChunkTokens = budget.chunkInputBudget * budget.maxChunks
  const totalTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
  if (totalTokens > maxChunkTokens) {
    throw new Error(
      `directive trim: input too large to trim in one pass (${totalTokens} tokens > `
      + `${budget.maxChunks} chunks × ${budget.chunkInputBudget}); compact the session first`,
    )
  }

  const chunks: TrimChunk[] = []
  let start = 0
  while (start < nodes.length) {
    let end = start
    let accumulated = 0
    for (; end < nodes.length; end += 1) {
      accumulated += nodes[end]!.tokens
      if (accumulated >= budget.chunkInputBudget) break
    }
    // Roll the cut back to a balanced boundary (never split a tool pair).
    // `end` may equal nodes.length (budget not reached at the tail); that cut
    // after the last node is balanced by definition, so only roll back when
    // `end` points at a real node.
    while (end < nodes.length && end > start && !isBalancedBefore(nodes[end]!)) end -= 1
    if (end === start) {
      // A single node alone exceeds the budget and cannot be balanced inward;
      // take it whole rather than looping forever.
      end = start + 1
    }
    const chunkNodes = nodes.slice(start, end)
    chunks.push({
      seqs: chunkNodes.map(node => node.seq),
      tokens: chunkNodes.reduce((sum, node) => sum + node.tokens, 0),
    })
    start = end
  }
  return chunks
}
