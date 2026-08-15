/**
 * The `/compact-directive <requirement>` command transaction.
 *
 * Reads the session surface, plans the head/middle/tail split, summarizes the
 * middle with the user's directive, and replaces it with one checkpoint
 * message through the session's own `surfaceOp: { op: 'replace' }` append —
 * recording the standard `compaction/start` / `compaction/summary` /
 * `compaction/end` lifecycle so the operation is reconstructable from the log.
 * @module @ya8d/dsh-directive-compact/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
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
import { planCompaction, type SurfaceNodeInfo } from './plan.js'
import { summarizeWithDirective, type DirectiveTarget } from './summarizer.js'

/** Resolved plugin configuration, subset the command layer needs. */
export interface CommandConfig {
  /** Leading user utterances whose full turns are preserved. */
  readonly keepHeadUsers: number
  /** Trailing user utterances whose full turns are preserved. */
  readonly keepTailUsers: number
  /** Summarization provider/model pair; empty pair resolves the routed target. */
  readonly summarizationProvider: string
  readonly summarizationModel: string
  /** Generation cap for the summarization call. */
  readonly maxTokens: number
}

/**
 * Expected directive-compaction failure classes, mirroring the upstream
 * `ManualCompactionErrorCode` shape so automatic compaction (P4) can reuse the
 * same classification.
 */
export type DirectiveCompactionErrorCode =
  | 'busy'
  | 'cancelled'
  | 'summary'
  | 'commit'

/** Expected directive-compaction failure carrying a stable code. */
export class DirectiveCompactionError extends Error {
  override readonly name = 'DirectiveCompactionError'
  constructor(
    readonly code: DirectiveCompactionErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Build the surface-node description from a session's current surface.
 * @param session - session whose surface is read.
 * @returns one descriptor per surface node, in model-visible order.
 */
export function surfaceNodes(session: Session): SurfaceNodeInfo[] {
  const events = session.events
  return session.surface.nodes.map(seq => {
    const event = events[seq]!
    let kind: string = event.type
    if (event.type === 'user/message') {
      const source = event.data.source as { kind?: string; plugin?: string } | undefined
      kind = source?.plugin ?? source?.kind ?? 'user'
    }
    return { seq, type: event.type as SurfaceNodeInfo['type'], kind }
  })
}

/** Resolve provider/model/maxTokens for the directive summarization call. */
export function resolveDirectiveTarget(
  agent: Agent,
  config: CommandConfig,
): DirectiveTarget {
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const routed = agent.session.requestHeader()?.config
  const routedTarget = routed !== undefined
    && routed.provider.length > 0
    && routed.model.length > 0
    ? { provider: routed.provider, model: routed.model }
    : undefined
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? routedTarget ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for directive summarization: set both summarization fields, route one request, or set both AgentOptions fields',
    )
  }
  return { ...target, maxTokens: config.maxTokens }
}

/** Project one surface node to its derived message, or null when none. */
function messageFor(session: Session, seq: number): Message | null {
  return session.deriveEventMessage(session.events[seq]!)
}

/**
 * Whether the session currently has an open turn (a `turn/start` whose paired
 * `turn/end` has not been logged). Standalone compaction (`turn: null`) is only
 * legal between turns; running it inside an open turn violates the session
 * invariant (`compaction/start is standalone but turn N is open`).
 * @param session - session whose log is inspected.
 * @returns the open turn number, or `null` when between turns.
 */
function openTurnNumber(session: Session): number | null {
  const events = session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'turn/end') return null
    if (event.type === 'turn/start') return event.data.turn
  }
  return null
}

/**
 * Execute one directive-driven compaction against the invoking agent.
 * @param ctx - context providing the LLM service.
 * @param invocation - the command invocation carrying agent, directive, signal.
 * @param config - resolved configuration.
 * @returns the command result to render.
 */
export async function executeDirectiveCompact(
  ctx: Context,
  invocation: CommandInvocation,
  config: CommandConfig,
): Promise<CommandResult> {
  const session = invocation.agent.session
  // Standalone compaction is only legal between turns; refuse while a turn is
  // open so the session invariant (`turn: null` inside an open turn) cannot trip.
  const openTurn = openTurnNumber(session)
  if (openTurn !== null) {
    throw new DirectiveCompactionError(
      'busy',
      'directive compaction requires an idle session; a turn is still in progress',
    )
  }

  const nodes = surfaceNodes(session)
  const plan = planCompaction(nodes, {
    keepHeadUsers: config.keepHeadUsers,
    keepTailUsers: config.keepTailUsers,
  })
  if (plan.kind === 'none') {
    return { kind: 'success', text: 'No compactable middle span yet.' }
  }

  const directive = invocation.rawInput.trim()
  const target = resolveDirectiveTarget(invocation.agent, config)

  // Middle span messages, in surface order, projected to the summarizer.
  const middleMessages = plan.middleSeqs
    .map(seq => messageFor(session, seq))
    .filter((message): message is Message => message !== null)
  if (middleMessages.length === 0) {
    return { kind: 'error', text: 'The middle span produced no messages to summarize.' }
  }

  const compactionId = CompactionId(crypto.randomUUID())
  const lifecycle = {
    compactionId,
    sourceCommandId: invocation.commandId,
    turn: null as number | null,
  }
  // Capture the start event at append time; the async summarization window
  // may see other appends, so never locate it by "last event" afterwards.
  const startEvent = session.append('compaction/start', lifecycle)
  // True once the summary record landed — a failure after this is a commit
  // failure (history may have changed), before it is a summary failure.
  let committing = false

  try {
    const summary = await summarizeWithDirective(
      ctx,
      target,
      middleMessages,
      directive,
      session.id,
      invocation.signal,
    )
    if (invocation.signal.aborted) {
      throw new DirectiveCompactionError('cancelled', 'directive compaction was cancelled')
    }
    const shadowedTokenCount = plan.middleSeqs.reduce((total, seq) => {
      const message = messageFor(session, seq)
      return total + (message === null ? 0 : ctx.tokenMeter.estimateMessage(message))
    }, 0)
    const shadowedRange = {
      start: plan.middleSeqs[0]!,
      end: plan.middleSeqs[plan.middleSeqs.length - 1]!,
    }
    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      sourceCommandId: invocation.commandId,
      summary: summary.summary,
      shadowedRange,
      shadowedSeqs: [...plan.middleSeqs],
      shadowedTokenCount,
      provider: summary.provider,
      model: summary.model,
      ...summary.maxTokens === undefined ? {} : { maxTokens: summary.maxTokens },
      ...summary.usage === undefined ? {} : { usage: summary.usage },
      // llmStreamCall is true for our clean call, so rawOutput is present.
      rawOutput: summary.rawOutput as ContentBlock[],
      llmStreamCall: true,
    })
    committing = true
    const checkpointMessage = createUserMessage({
      content: summary.summary,
      source: compactCheckpointSource(compactionId, invocation.commandId),
    })
    session.append('user/message', checkpointMessage, {
      surfaceOp: { op: 'replace', start: shadowedRange.start, end: shadowedRange.end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...plan.middleSeqs],
    })
    session.append('compaction/end', lifecycle)
    return {
      kind: 'success',
      text: `Compacted ${plan.middleSeqs.length} history items (~${shadowedTokenCount} tokens) per the directive.`,
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
