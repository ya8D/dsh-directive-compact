/**
 * The `/trim-directive <requirement>` command transaction.
 *
 * Hands the ENTIRE surface to the model with a directive-only prompt, and
 * replaces it with the model's trimmed output as one checkpoint. Full freedom
 * (P10): no head, no tail, no system-node protection — the injected skeleton
 * (`agent-instructions` / `system-prompt` / `skill-catalog`) and any `compact`
 * checkpoint are trim-able like any other node. That is safe because the agent
 * loop re-injects the skeleton on every request (`systemPrompt.assemble()` in
 * `preStep`, `agent-instructions` composing into `agent/pre-step` messages),
 * so the model keeps its environment without manual re-injection. The only
 * constraint kept is tool-pairing balance (a replace cannot split a
 * tool-call/result pair).
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
import type { ContentBlock, Message, TextBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: activates the `ctx.tokenMeter` declaration on the Cordis context.
import type {} from '@deepseek-ai/dsh-token-meter'
import { renderSpan, summarizeWithDirective } from './summarizer.js'
import type { DirectiveSummaryResult, DirectiveTarget } from './summarizer.js'
import { CHECKPOINT_GUARD } from './summarizer.js'
import { buildTrimPrompt, chunkTrimNodes, resolveTrimBudget, trimMarker, TRIM_NO_CHANGE_MARKER, type PricedTrimNode, type TrimBudget } from './trim.js'
import { buildOpModePrompt, executeOpManifest, parseOpManifest, renderSpanNumbered, validateOpManifest, type OpManifest } from './op-mode.js'
import { DirectiveCompactionError, openTurnNumber, resolveDirectiveTarget } from './command.js'
import { shortDirective } from './log.js'

/**
 * Whether a chunk call declared "nothing to change": its whole text output,
 * trimmed and with wrapping backticks stripped, equals the no-change marker.
 * Anything else (including a marker plus extra content) counts as changed and
 * is assembled normally — a model that misuses the marker cannot silently drop
 * content, it only fails to shrink that chunk.
 * @param result - one chunk's summarization result.
 * @returns true when the model replied with exactly the no-change marker.
 */
function isNoChangeMarker(result: DirectiveSummaryResult): boolean {
  const text = (result.rawOutput ?? [])
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
  return text.replace(/^`+|`+$/g, '') === TRIM_NO_CHANGE_MARKER
}

/**
 * Select the trim range: the ENTIRE surface, with no system-node protection.
 *
 * Full freedom (user-confirmed): a trim may reach every surface node,
 * including the injected skeleton (`agent-instructions` / `system-prompt` /
 * `skill-catalog`) and any `compact` checkpoint. This is safe because those
 * injections are re-created on every request by the agent loop
 * (`systemPrompt.assemble()` in `preStep`, `agent-instructions` composing into
 * `agent/pre-step` messages) — deleting the surface copies does not remove the
 * model's environment. A `compact` checkpoint's content lives in the
 * append-only log, recoverable by tooling. The only constraint kept is
 * tool-pairing balance (a replace cannot split a tool-call/result pair).
 * @param session - session whose surface is read.
 * @returns the full inclusive span, or `null` when the surface is empty.
 */
function selectTrimRange(session: Session): { start: number; end: number; shadowedSeqs: number[] } | null {
  const surface = session.surface.nodes
  if (surface.length === 0) return null
  return { start: surface[0]!, end: surface[surface.length - 1]!, shadowedSeqs: [...surface] }
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
  const logger = ctx.logger('dsh-directive-compact')
  const startedAt = Date.now()
  const session = invocation.agent.session
  const directive = invocation.rawInput.trim()
  if (directive.length === 0) {
    // Returned as a structured error (not thrown) deliberately, mirroring
    // `/compact-directive`: this is a parameter-validation failure — static,
    // side-effect-free, before any `compaction/start` opens — so the command
    // layer renders it as a usage hint. Failures DURING the lifecycle (shrink
    // rejection, summarization) must throw so the catch block closes the
    // opened lifecycle; the two failure styles are distinct on purpose.
    logger.debug('trim-directive: refused — empty directive')
    return {
      kind: 'error',
      text: 'Usage: /trim-directive <requirement> — a natural-language description of what to delete and what to keep',
    }
  }
  // The trim is a standalone summarization transaction between turns; refuse
  // while a turn is open so the rewrite cannot race an in-flight request.
  if (openTurnNumber(session) !== null) {
    logger.debug('trim-directive: refused — an open turn is still in progress')
    throw new DirectiveCompactionError(
      'busy',
      'directive trim requires an idle session; a turn is still in progress',
    )
  }

  const range = selectTrimRange(session)
  if (range === null) {
    logger.debug('trim-directive: refused — empty surface')
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
  // min(window/2, adapter max output), per-chunk input = 50K heuristic tokens
  // (fixed; targets the 1M-window DeepSeek models), max 20 chunks.
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
  logger.info(
    'trim-directive: begin — directive "%s", surface %d nodes, budget maxTokens %d / chunk input %d / max chunks %d',
    shortDirective(directive), shadowedSeqs.length,
    budget.maxTokens, budget.chunkInputBudget, budget.maxChunks,
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
    const pricedTokens = priced.reduce((total, node) => total + node.tokens, 0)
    logger.info(
      'trim-directive: priced %d nodes (~%d tokens) → %d chunk(s)',
      priced.length, pricedTokens, chunks.length,
    )
    for (const [index, chunk] of chunks.entries()) {
      logger.debug(
        'trim-directive: chunk %d/%d — seqs %d-%d, ~%d tokens',
        index + 1, chunks.length, chunk.seqs[0], chunk.seqs[chunk.seqs.length - 1], chunk.tokens,
      )
    }

    // Every chunk runs in full parallel (up to 20 — no artificial concurrency
    // cap). Each chunk FIRST runs the operation-mode call (P11): the model
    // outputs a delete/rewrite/summarize manifest over the numbered nodes and
    // the plugin executes it programmatically (kept nodes splice verbatim —
    // zero generation, 100% fidelity; only rewrite/summarize content is
    // model-generated). A manifest that parses and validates executes; a
    // no-change chunk keeps its original rendering; anything else (prose,
    // malformed manifest, balance violation) falls back to the existing
    // rewrite-mode call. HTTP 429 rate limits are retried by the adapter's
    // retryPolicy and again by the per-chunk retry below.
    //
    // Per-chunk retry: a transient failure on ONE chunk (network hiccup,
    // proxy switch, adapter 5xx) must not sink the whole trim. Each chunk gets
    // up to 3 attempts (1 initial + 2 retries); cancellation and abort are
    // never retried.
    type ChunkResult =
      | { kind: 'op'; content: string; index: number; rawOutput: ContentBlock[]; usage?: TokenUsage }
      | { kind: 'rewrite'; result: DirectiveSummaryResult; index: number; chunkMessages: Message[]; noChange: boolean; usage?: TokenUsage }
    const chunkResults = await Promise.all(chunks.map(async (chunk, index): Promise<ChunkResult> => {
      const chunkMessages: Message[] = chunk.seqs.flatMap((seq) => {
        const event = session.events[seq]
        return event === undefined ? [] : (session.deriveEventMessage(event) === null ? [] : [session.deriveEventMessage(event)!])
      })
      const messagesBySeq = new Map<number, Message>()
      for (const seq of chunk.seqs) {
        const event = session.events[seq]
        const message = event === undefined ? null : session.deriveEventMessage(event)
        if (message !== null) messagesBySeq.set(seq, message)
      }
      const chunkStartedAt = Date.now()
      // Operation-mode call: numbered rendering + strict manifest contract.
      const opCall = await summarizeChunkWithRetry(
        ctx,
        target,
        budget,
        chunkMessages,
        directive,
        session.id,
        invocation.signal,
        buildOpModePrompt,
        trimMarker,
        () => renderSpanNumbered(chunk.seqs, messagesBySeq),
      )
      const parsed = parseOpManifest(resultText(opCall))
      if (parsed.kind === 'manifest') {
        const validation = validateOpManifest(parsed.manifest, chunk.seqs, session)
        if (validation.kind === 'ok') {
          // Conservative-drop diagnostics (P12): rewrites dropped by the
          // inflation guard and delete-text fragments that did not match are
          // kept verbatim — surface why, so a "nothing happened" chunk is not
          // silent.
          for (const seq of parsed.manifest.rewrites.keys()) {
            if (!validation.manifest.rewrites.has(seq)) {
              logger.warn(
                'trim-directive: chunk %d/%d rewrite seq %d dropped (inflation guard: content > 1.1x original); original kept verbatim',
                index + 1, chunks.length, seq,
              )
            }
          }
          for (const textDelete of parsed.manifest.deleteTexts ?? []) {
            if (!(validation.manifest.deleteTexts ?? []).some(kept => kept.seq === textDelete.seq)) {
              logger.warn(
                'trim-directive: chunk %d/%d delete-text seq %d fragment not found in the node; original kept verbatim | fragment: %s',
                index + 1, chunks.length, textDelete.seq, JSON.stringify(textDelete.fragment.slice(0, 120)),
              )
            }
          }
          const content = executeOpManifest(validation.manifest, chunk.seqs, session)
          logger.info(
            'trim-directive: chunk %d/%d done in %dms (op-mode: %d delete, %d rewrite, %d summarize, %d delete-text)',
            index + 1, chunks.length, Date.now() - chunkStartedAt,
            validation.manifest.deletes.length, validation.manifest.rewrites.size,
            validation.manifest.summarizes.length, validation.manifest.deleteTexts?.length ?? 0,
          )
          return { kind: 'op', content, index, rawOutput: opCall.rawOutput ?? [], usage: opCall.usage }
        }
        const invalid = validation.reason
        // The manifest parses but is semantically invalid (out-of-range seqs,
        // overlaps, split tool pairs — rare, meaning the model misread the
        // nodes). A second rewrite-mode call is the correct-cost fallback:
        // the op-mode output is a manifest here, NOT usable as content.
        logger.warn(
          'trim-directive: chunk %d/%d op manifest invalid: %s\n'
          + '  manifest: %s\n'
          + '  model output (first 400 chars): %s',
          index + 1, chunks.length, invalid,
          manifestSummary(parsed.manifest),
          JSON.stringify(resultText(opCall).slice(0, 400)),
        )
        const result = await summarizeChunkWithRetry(
          ctx,
          target,
          budget,
          chunkMessages,
          directive,
          session.id,
          invocation.signal,
        )
        const noChange = isNoChangeMarker(result)
        logger.info(
          'trim-directive: chunk %d/%d done in %dms (rewrite-mode fallback, %d output tokens)%s',
          index + 1, chunks.length, Date.now() - chunkStartedAt, result.usage?.outputTokens ?? 0,
          noChange ? ' — model declared no change; original content kept verbatim' : '',
        )
        return { kind: 'rewrite', result, index, chunkMessages, noChange, usage: mergeUsage(opCall.usage, result.usage) }
      } else if (parsed.kind === 'no-change') {
        const content = executeOpManifest(null, chunk.seqs, session)
        logger.info(
          'trim-directive: chunk %d/%d done in %dms (op-mode: no change; original kept verbatim)',
          index + 1, chunks.length, Date.now() - chunkStartedAt,
        )
        return { kind: 'op', content, index, rawOutput: opCall.rawOutput ?? [], usage: opCall.usage }
      }
      // Prose output: the model chose FORM 2 (or ignored the prompt). Its
      // output IS its rewrite of the chunk, so reuse it directly — a second
      // rewrite call would double the wall time of the slowest chunk (measured
      // on a real run: op prose + fallback ≈ 14 min for one 45K-token chunk).
      // `noChange` is always false here: parseOpManifest already classified
      // this output as prose using the SAME marker test isNoChangeMarker uses,
      // so a marker-only reply can never reach this branch.
      logger.warn(
        'trim-directive: chunk %d/%d op-mode prose output (%s); using it as the rewrite result (no second call)\n'
        + '  model output (first 400 chars): %s',
        index + 1, chunks.length, parsed.reason,
        JSON.stringify(resultText(opCall).slice(0, 400)),
      )
      logger.info(
        'trim-directive: chunk %d/%d done in %dms (op-mode prose as rewrite result, %d output tokens)',
        index + 1, chunks.length, Date.now() - chunkStartedAt, opCall.usage?.outputTokens ?? 0,
      )
      return { kind: 'rewrite', result: opCall, index, chunkMessages, noChange: false, usage: opCall.usage }
    }))
    if (invocation.signal.aborted) {
      throw new DirectiveCompactionError('cancelled', 'directive trim was cancelled')
    }
    logger.info('trim-directive: all %d chunks done in %dms', chunks.length, Date.now() - startedAt)

    // Assemble one checkpoint: marker + guard once, then each chunk's content
    // under a [part N/M] divider. An op-mode chunk contributes its executed
    // manifest output (kept nodes spliced verbatim, rewrite/summarize replaced,
    // deletes dropped); a rewrite-mode chunk contributes the model's trimmed
    // output, or its ORIGINAL rendering verbatim when the model declared no
    // change (the content must survive in the checkpoint anyway, and paying
    // the model to regenerate it is the entire wall-time cost).
    const partCount = chunkResults.length
    const assembled: ContentBlock[] = [
      { type: 'text', text: trimMarker(directive) },
      { type: 'text', text: CHECKPOINT_GUARD },
    ]
    const rawOutput: ContentBlock[] = []
    let usage: TokenUsage | undefined
    for (const chunkResult of chunkResults) {
      if (partCount > 1) {
        assembled.push({ type: 'text', text: `[part ${chunkResult.index + 1}/${partCount}]` })
      }
      if (chunkResult.kind === 'op') {
        assembled.push({ type: 'text', text: chunkResult.content })
        rawOutput.push(...chunkResult.rawOutput)
        usage = mergeUsage(usage, chunkResult.usage)
      } else if (chunkResult.noChange) {
        assembled.push({ type: 'text', text: renderSpan(chunkResult.chunkMessages) })
        rawOutput.push(...chunkResult.result.rawOutput ?? [])
        usage = mergeUsage(usage, chunkResult.usage)
      } else {
        for (const block of chunkResult.result.summary) {
          // Skip the per-chunk marker/guard repeats; the single head covers them.
          if (block.type === 'text'
            && (block.text === trimMarker(directive) || block.text === CHECKPOINT_GUARD)) continue
          assembled.push(block)
        }
        rawOutput.push(...chunkResult.result.rawOutput ?? [])
        usage = mergeUsage(usage, chunkResult.usage)
      }
    }

    const shadowedTokenCount = priced.reduce((total, node) => total + node.tokens, 0)
    const checkpoint = createUserMessage({
      content: assembled,
      source: compactCheckpointSource(compactionId, invocation.commandId),
    })
    const framedTokenCount = ctx.tokenMeter.estimateMessage(checkpoint)
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
    if (framedTokenCount >= shadowedTokenCount) {
      // No change: the model's output is not smaller than the shadowed span
      // (typically it found nothing matching the requirement and returned the
      // context essentially verbatim). That is a normal outcome, not a
      // failure: record the output in the lifecycle, leave the surface
      // untouched, and tell the user — never throw into a retry/hang on a
      // rewrite that cannot shrink.
      session.append('compaction/end', lifecycle)
      logger.info(
        'trim-directive: no change — checkpoint %d tokens >= shadowed %d tokens; surface untouched',
        framedTokenCount, shadowedTokenCount,
      )
      return {
        kind: 'success',
        text: `Nothing to trim: the model found no content worth removing (~${shadowedTokenCount} tokens unchanged).`,
        sourceEventSeq: summaryEvent.seq,
      }
    }
    committing = true
    session.append('user/message', checkpoint, {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    })
    session.append('compaction/end', lifecycle)
    logger.info(
      'trim-directive: committed — trimmed %d nodes (~%d tokens) → checkpoint %d tokens, %dms total',
      shadowedSeqs.length, shadowedTokenCount, framedTokenCount, Date.now() - startedAt,
    )
    return {
      kind: 'success',
      text: `Trimmed ${shadowedSeqs.length} history items (~${shadowedTokenCount} tokens, ${partCount} chunk${partCount === 1 ? '' : 's'}) per the requirement.`,
      sourceEventSeq: summaryEvent.seq,
    }
  } catch (error: unknown) {
    // A failed attempt still closes the lifecycle with the error.
    session.append('compaction/end', { ...lifecycle, error: String(error) })
    logger.warn(
      'trim-directive: failed — %s (%dms)',
      error instanceof Error ? error.message : String(error), Date.now() - startedAt,
    )
    if (error instanceof DirectiveCompactionError) throw error
    if (committing) {
      throw new DirectiveCompactionError('commit', String(error))
    }
    throw new DirectiveCompactionError('summary', String(error))
  }
}

/**
 * Summarize one trim chunk with bounded retries.
 *
 * A transient failure on one chunk (network hiccup, proxy switch, adapter
 * 5xx) retries the SAME chunk content up to 2 extra times (3 attempts total)
 * before giving up, so a single flaky call cannot sink a whole parallel trim.
 * Cancellation and aborted signals are never retried — they propagate
 * immediately.
 *
 * Retry policy: any non-`DirectiveCompactionError` throw is retried, including
 * a `MAX_TOKENS` truncation. That is a deliberate trade: the budget already
 * derives maxTokens from the window (256K on deepseek), so deterministic
 * truncation is rare, while a transient failure that truncates mid-stream is
 * worth retrying. Expected compaction failures (shrink, cancelled) never
 * retry.
 * @param ctx - context providing the LLM service.
 * @param target - resolved provider/model pair.
 * @param budget - window-derived budget (maxTokens applied per call).
 * @param messages - this chunk's messages, in surface order.
 * @param directive - the user's trim requirement.
 * @param sessionId - owning session id for request routing.
 * @param signal - cancellation signal; retries stop when it aborts.
 * @param promptBuilder - prompt prefix for this call; the operation-mode path
 *   passes `buildOpModePrompt`, the rewrite path the default `buildTrimPrompt`.
 * @param markerBuilder - checkpoint marker builder; both paths pass `trimMarker`.
 * @param renderer - span renderer; the operation-mode path passes the numbered
 *   renderer so the model can reference nodes by seq.
 * @returns the summarization result from the first successful attempt.
 */
async function summarizeChunkWithRetry(
  ctx: Context,
  target: DirectiveTarget,
  budget: TrimBudget,
  messages: readonly Message[],
  directive: string,
  sessionId: SessionId,
  signal: AbortSignal,
  promptBuilder: (directive: string | undefined) => string = buildTrimPrompt,
  markerBuilder: (directive: string) => string = trimMarker,
  renderer?: (messages: readonly Message[]) => string,
): Promise<DirectiveSummaryResult> {
  const logger = ctx.logger('dsh-directive-compact')
  const attempts = 3 // 1 initial + 2 retries
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal.aborted) throw new DirectiveCompactionError('cancelled', 'directive trim was cancelled')
    try {
      return await summarizeWithDirective(
        ctx,
        { ...target, maxTokens: budget.maxTokens },
        messages,
        directive,
        sessionId,
        signal,
        promptBuilder,
        markerBuilder,
        renderer,
      )
    } catch (error: unknown) {
      lastError = error
      if (signal.aborted) throw error
      // Non-retryable: expected directive-compaction failures (shrink etc.)
      // are not transient network issues.
      if (error instanceof DirectiveCompactionError) throw error
      if (attempt < attempts - 1) {
        logger.warn(
          'trim-directive: chunk call failed, retrying (%d/%d): %s',
          attempt + 2, attempts,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }
  throw lastError
}

/** The chunk call's full text output, newline-joined (for manifest parsing). */
function resultText(result: DirectiveSummaryResult): string {
  return (result.rawOutput ?? [])
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** One-line summary of a parsed manifest for diagnostics. */
function manifestSummary(manifest: OpManifest): string {
  const parts: string[] = []
  if (manifest.deletes.length > 0) parts.push(`delete [${manifest.deletes.join(', ')}]`)
  if (manifest.rewrites.size > 0) parts.push(`rewrite [${[...manifest.rewrites.keys()].join(', ')}]`)
  for (const range of manifest.summarizes) parts.push(`summarize [${range.start}-${range.end}]`)
  return parts.length === 0 ? '(empty)' : parts.join('; ')
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
