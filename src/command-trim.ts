/**
 * The `/trim-directive <requirement>` command transaction.
 *
 * Hands the ENTIRE conversational surface (real user utterances, assistant
 * replies, tool results — but NOT the injected system nodes) to the model with
 * a directive-only prompt, and replaces the whole trim range with the model's
 * trimmed output as one checkpoint. Zero region protection: the user's
 * natural-language requirement decides what survives. System nodes
 * (`agent-instructions` / `system-prompt` / `skill-catalog`) are session
 * machinery, not dialogue — they are excluded from the render AND from the
 * replaced range, so the model keeps its environment after the trim.
 * @module @ya8d/dsh-directive-compact/command-trim
 */

import type { Context } from '@deepseek-ai/cordis'
import { CompactionId, compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
// Type-only: activates the compaction lifecycle event declarations on the
// session event map (`compaction/start` / `compaction/summary` / `compaction/end`).
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: activates the `ctx.tokenMeter` declaration on the Cordis context.
import type {} from '@deepseek-ai/dsh-token-meter'
import { summarizeWithDirective } from './summarizer.js'
import { CHECKPOINT_GUARD } from './summarizer.js'
import { buildTrimPrompt, chunkTrimNodes, resolveTrimBudget, trimMarker, type PricedTrimNode } from './trim.js'
import { DirectiveCompactionError, openTurnNumber, resolveDirectiveTarget, surfaceNodes } from './command.js'

/**
 * Whether a surface node is injected system context rather than real dialogue.
 * System injections are `user/message` events whose source kind is a plugin
 * name (`agent-instructions`, `@deepseek-ai/dsh-system-prompt`,
 * `skill-catalog`, or a `compact` checkpoint). They are session machinery:
 * injected once at session start, never re-injected after a replacement, and
 * required for the model's environment — so they are never trim-able content.
 *
 * The dual of `plan.ts`'s `isUserUtterance` (which tests the same
 * `user/message` source-kind distinction for the opposite answer); the two
 * take different inputs on purpose — this one raw `kind`/`type` for the
 * surface-node list, that one a `SurfaceNodeInfo` — so neither supersedes the
 * other, and this is the only `isInjectedSystemNode` in the package.
 * @param kind - the node's source kind (see {@link surfaceNodes}).
 * @param type - the node's surface event type.
 * @returns true when the node is injected system context.
 */
export function isInjectedSystemNode(kind: string, type: string): boolean {
  return type === 'user/message' && kind !== 'user'
}

/**
 * Select the trim range: from just after the LAST injected system node through
 * the surface tail. System nodes (`agent-instructions` / `system-prompt` /
 * `skill-catalog`) sit between the first user message and the rest of the
 * dialogue, and a surface `replace` shadows one contiguous range — so the only
 * range that keeps every injected node outside the replacement is the span
 * after the last one. The session's opening anchor (first user message) stays
 * outside too, as a structural consequence, not a protection policy.
 * @param session - session whose surface is read.
 * @returns the inclusive span of trim-able nodes, or `null` when none exist.
 */
function selectTrimRange(session: Session): { start: number; end: number; shadowedSeqs: number[] } | null {
  const surface = session.surface.nodes
  const nodes = surfaceNodes(session)
  const lastInjected = nodes.findLastIndex(info => isInjectedSystemNode(info.kind, info.type))
  const firstTrim = lastInjected + 1
  const lastTrim = nodes.findLastIndex(info => !isInjectedSystemNode(info.kind, info.type))
  if (firstTrim > lastTrim || lastTrim === -1) return null
  const start = surface[firstTrim]!
  const end = surface[lastTrim]!
  const shadowedSeqs = surface.slice(firstTrim, lastTrim + 1)
  return { start, end, shadowedSeqs }
}

/**
 * Execute one AI-driven free trim against the invoking agent.
 * @param ctx - context providing the LLM service and token meter.
 * @param invocation - the command invocation carrying agent, directive, signal.
 * @returns the command result to render.
 */
export async function executeTrim(
  ctx: Context,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const session = invocation.agent.session
  const directive = invocation.rawInput.trim()
  if (directive.length === 0) {
    // Returned as a structured error (not thrown) deliberately, mirroring
    // `/compact-directive`: this is a parameter-validation failure — static,
    // side-effect-free, before any `compaction/start` opens — so the command
    // layer renders it as a usage hint. Failures DURING the lifecycle (shrink
    // rejection, summarization) must throw so the catch block closes the
    // opened lifecycle; the two failure styles are distinct on purpose.
    return {
      kind: 'error',
      text: 'Usage: /trim-directive <requirement> — a natural-language description of what to delete and what to keep',
    }
  }
  // The trim is a standalone summarization transaction between turns; refuse
  // while a turn is open so the rewrite cannot race an in-flight request.
  if (openTurnNumber(session) !== null) {
    throw new DirectiveCompactionError(
      'busy',
      'directive trim requires an idle session; a turn is still in progress',
    )
  }

  const range = selectTrimRange(session)
  if (range === null) {
    return { kind: 'success', text: 'No conversational content to trim.' }
  }

  // The replaced span must be tool-pairing balanced so a tool-call/result pair
  // is never split; expand the range outward until both boundaries hold.
  const surface = session.surface.nodes
  let startIdx = surface.indexOf(range.start)
  let endIdx = surface.indexOf(range.end)
  while (startIdx > 0 && !toolPairingBalancedBefore(session, surface[startIdx]!)) startIdx -= 1
  while (endIdx < surface.length - 1 && !toolPairingBalancedAfter(session, surface[endIdx]!)) endIdx += 1
  if (!toolPairingBalancedBefore(session, surface[startIdx]!)) {
    throw new DirectiveCompactionError(
      'summary',
      'directive trim: cannot find a balanced cut before the trim range',
    )
  }
  if (!toolPairingBalancedAfter(session, surface[endIdx]!)) {
    throw new DirectiveCompactionError(
      'summary',
      'directive trim: cannot find a balanced cut after the trim range',
    )
  }
  const start = surface[startIdx]!
  const end = surface[endIdx]!
  const shadowedSeqs = surface.slice(startIdx, endIdx + 1)

  const target = resolveDirectiveTarget(invocation.agent, {
    keepHeadUsers: 0,
    keepTailUsers: 0,
    summarizationProvider: '',
    summarizationModel: '',
    maxTokens: 8192, // placeholder; replaced by the window-derived budget below
  })
  // Budget the summarization against the routed model's real window so no
  // single call (and no chunk) can overflow the context: maxTokens =
  // min(window/2, adapter max output), per-chunk input = window/5.
  const modelInfo = await ctx.llm.resolveModelInfo(target.provider, target.model, invocation.signal)
  if (modelInfo.context?.contextWindow === undefined) {
    // A silent 1M fallback would over-budget a smaller-window model (chunks
    // sized for 1M could overflow a 32K window); fail loud instead.
    throw new DirectiveCompactionError(
      'summary',
      `directive trim: model ${target.provider}/${target.model} reports no context window; cannot budget the trim`,
    )
  }
  const budget = resolveTrimBudget(
    modelInfo.context.contextWindow,
    256_000, // adapter hard per-response cap (llm-deepseek DEFAULT_MAX_TOKENS)
  )

  const compactionId = CompactionId(crypto.randomUUID())
  const lifecycle = {
    compactionId,
    sourceCommandId: invocation.commandId,
    turn: null as number | null,
  }
  // Capture the start event at append time; the async summarization window may
  // see other appends, so never locate it by "last event" afterwards.
  const startEvent = session.append('compaction/start', lifecycle)
  let committing = false

  try {
    // Price every shadowed node ONCE via the token meter, then slice into
    // budget-sized chunks with balanced cut points.
    const measurement = ctx.tokenMeter.measure(session)
    const priced: PricedTrimNode[] = shadowedSeqs.flatMap((seq) => {
      const node = measurement.nodes.find(n => n.seq === seq)
      return node === undefined ? [] : [{ seq, tokens: node.tokens }]
    })
    const chunks = chunkTrimNodes(priced, budget, node => toolPairingBalancedBefore(session, node.seq))
    if (chunks.length === 0) {
      return { kind: 'success', text: 'No conversational content to trim.' }
    }

    // Summarize every chunk in parallel. Each chunk is a full trim call over
    // its own rendered span; HTTP 429 rate limits are retried by the adapter's
    // retryPolicy. All chunks share the same directive and marker.
    const chunkResults = await Promise.all(chunks.map(async (chunk, index) => {
      const chunkMessages: Message[] = chunk.seqs.flatMap((seq) => {
        const event = session.events[seq]
        return event === undefined ? [] : (session.deriveEventMessage(event) === null ? [] : [session.deriveEventMessage(event)!])
      })
      const result = await summarizeWithDirective(
        ctx,
        { ...target, maxTokens: budget.maxTokens },
        chunkMessages,
        directive,
        session.id,
        invocation.signal,
        buildTrimPrompt,
        trimMarker,
      )
      return { result, index }
    }))
    if (invocation.signal.aborted) {
      throw new DirectiveCompactionError('cancelled', 'directive trim was cancelled')
    }

    // Assemble one checkpoint: marker + guard once, then each chunk's text
    // blocks under a [part N/M] divider.
    const partCount = chunkResults.length
    const assembled: ContentBlock[] = [
      { type: 'text', text: trimMarker(directive) },
      { type: 'text', text: CHECKPOINT_GUARD },
    ]
    const rawOutput: ContentBlock[] = []
    let usage: TokenUsage | undefined
    for (const { result, index } of chunkResults) {
      if (partCount > 1) {
        assembled.push({ type: 'text', text: `[part ${index + 1}/${partCount}]` })
      }
      for (const block of result.summary) {
        // Skip the per-chunk marker/guard repeats; the single head covers them.
        if (block.type === 'text'
          && (block.text === trimMarker(directive) || block.text === CHECKPOINT_GUARD)) continue
        assembled.push(block)
      }
      rawOutput.push(...result.rawOutput ?? [])
      usage = mergeUsage(usage, result.usage)
    }

    const shadowedTokenCount = priced.reduce((total, node) => total + node.tokens, 0)
    // Shrink validation: the framed checkpoint must be smaller than the
    // shadowed span (mirror of the upstream convergence check).
    const checkpoint = createUserMessage({
      content: assembled,
      source: compactCheckpointSource(compactionId, invocation.commandId),
    })
    const framedTokenCount = ctx.tokenMeter.estimateMessage(checkpoint)
    if (framedTokenCount >= shadowedTokenCount) {
      throw new DirectiveCompactionError(
        'summary',
        `directive trim did not shrink the context (checkpoint ${framedTokenCount} tokens >= shadowed ${shadowedTokenCount})`,
      )
    }
    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      sourceCommandId: invocation.commandId,
      summary: assembled,
      shadowedRange: { start, end },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount,
      provider: target.provider,
      model: target.model,
      maxTokens: budget.maxTokens,
      ...usage === undefined ? {} : { usage },
      rawOutput,
      llmStreamCall: true,
    })
    committing = true
    session.append('user/message', checkpoint, {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    })
    session.append('compaction/end', lifecycle)
    return {
      kind: 'success',
      text: `Trimmed ${shadowedSeqs.length} history items (~${shadowedTokenCount} tokens, ${partCount} chunk${partCount === 1 ? '' : 's'}) per the requirement.`,
      sourceEventSeq: summaryEvent.seq,
    }
  } catch (error: unknown) {
    // A failed attempt still closes the lifecycle with the error.
    session.append('compaction/end', { ...lifecycle, error: String(error) })
    if (error instanceof DirectiveCompactionError) throw error
    if (committing) {
      throw new DirectiveCompactionError('commit', String(error))
    }
    throw new DirectiveCompactionError('summary', String(error))
  }
}

/** Sum disjoint provider usage buckets across chunk calls. */
function mergeUsage(
  left: TokenUsage | undefined,
  right: TokenUsage | undefined,
): TokenUsage | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...left.cacheReadTokens === undefined && right.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0) },
    ...left.cacheWriteTokens === undefined && right.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0) },
    ...left.reasoningTokens === undefined && right.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0) },
  }
}
