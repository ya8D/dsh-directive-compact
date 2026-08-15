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
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: activates the `ctx.tokenMeter` declaration on the Cordis context.
import type {} from '@deepseek-ai/dsh-token-meter'
import { summarizeWithDirective } from './summarizer.js'
import { buildTrimPrompt, trimMarker } from './trim.js'
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

  // Render only the trim-able dialogue for the model; injected system nodes
  // stay out of both the prompt and the replaced range.
  const messages: Message[] = shadowedSeqs.flatMap((seq) => {
    const event = session.events[seq]
    return event === undefined ? [] : (session.deriveEventMessage(event) === null ? [] : [session.deriveEventMessage(event)!])
  })
  if (messages.length === 0) {
    return { kind: 'success', text: 'No conversational content to trim.' }
  }

  const target = resolveDirectiveTarget(invocation.agent, {
    keepHeadUsers: 0,
    keepTailUsers: 0,
    summarizationProvider: '',
    summarizationModel: '',
    maxTokens: 8192,
  })

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
    const summary = await summarizeWithDirective(
      ctx,
      target,
      messages,
      directive,
      session.id,
      invocation.signal,
      buildTrimPrompt,
      trimMarker,
    )
    if (invocation.signal.aborted) {
      throw new DirectiveCompactionError('cancelled', 'directive trim was cancelled')
    }
    const shadowedTokenCount = shadowedSeqs.reduce((total, seq) => {
      const event = session.events[seq]
      const message = event === undefined ? null : session.deriveEventMessage(event)
      return total + (message === null ? 0 : ctx.tokenMeter.estimateMessage(message))
    }, 0)
    // Shrink validation: the framed checkpoint must be smaller than the
    // shadowed span (mirror of the upstream convergence check).
    const checkpoint = createUserMessage({
      content: summary.summary,
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
      summary: summary.summary,
      shadowedRange: { start, end },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount,
      provider: summary.provider,
      model: summary.model,
      ...summary.maxTokens === undefined ? {} : { maxTokens: summary.maxTokens },
      ...summary.usage === undefined ? {} : { usage: summary.usage },
      rawOutput: summary.rawOutput as ContentBlock[],
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
      text: `Trimmed ${shadowedSeqs.length} history items (~${shadowedTokenCount} tokens) per the requirement.`,
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
