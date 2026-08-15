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
  /** Per-chunk input cap: contextWindow/4. */
  readonly chunkInputBudget: number
  /** Hard cap on chunk count (worst-case fragmentation bound). */
  readonly maxChunks: number
}

/**
 * Resolve the summarization budget from the routed model's context window.
 *
 * The window is the MAXIMUM COMBINED request + response token capacity
 * (`LlmModelContext.contextWindow`), so every number is derived from it:
 * - output cap = min(window/2, adapter max output) — half the window for the
 *   response, but never above the adapter's hard per-response limit (256K for
 *   deepseek); reasoning tokens count toward this cap, so the model's thinking
 *   shares it with the visible output;
 * - per-chunk input = window/5 — a chunk occupies input + output <=
 *   window/5 + window/2, leaving headroom for token-meter estimation error and
 *   request overhead, and keeping the output cap able to rewrite the input
 *   when thinking consumes up to ~56K of the 256K;
 * - max chunks = 10 — the worst-case fragmentation bound over the real
 *   1,000,000-token window: a single very large node (e.g. ~101K, over half
 *   the chunk budget) can fill a chunk alone, so 10 chunks cover the full
 *   window; the final partial chunk rides on an earlier one's headroom, never
 *   adding an extra chunk. More chunks would mean total input > window, which
 *   the model cannot read anyway.
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
    chunkInputBudget: Math.floor(contextWindow / 5),
    maxChunks: 10,
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
