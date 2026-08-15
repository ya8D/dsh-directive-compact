/**
 * Pure-incremental directive-driven compaction for DeepSeek Harness.
 *
 * Registers two global commands. `/compact-directive <requirement>` keeps the
 * session's fixed skeleton and the head/tail user turns, and summarizes the
 * middle span per the user's natural-language requirement. `/trim-directive
 * <pattern>` deletes every surface node whose rendered text matches the
 * pattern, with zero region protection, through the upstream model-free prune
 * protocol. Neither inherits `BasicCompactionEngine` nor registers
 * `ctx.compaction`, so both coexist with the upstream backend unchanged.
 * @module @ya8d/dsh-directive-compact
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import { executeDirectiveCompact, DirectiveCompactionError, type CommandConfig } from './command.js'
import { executeTrim } from './command-trim.js'

/** Plugin configuration, every field optional with a default. */
export const Config = z.object({
  /** Leading user utterances whose full turns are preserved. */
  keepHeadUsers: z.number().step(1).min(1).default(3),
  /** Trailing user utterances whose full turns are preserved. */
  keepTailUsers: z.number().step(1).min(1).default(3),
  /** Summarization provider; empty resolves the routed request target. */
  summarizationProvider: z.string().default(''),
  /** Summarization model; empty resolves the routed request target. */
  summarizationModel: z.string().default(''),
  /** Generation cap for the summarization call. */
  maxTokens: z.number().step(1).min(1).default(8192),
}) as z<CommandConfig>

/** Function-plugin entry name (no default export; the Loader drops it otherwise). */
export const name = 'dsh-directive-compact'

/** Services the commands need: registry, session/message seam, LLM, and metering. */
export const inject = ['commands', 'sessions', 'llm', 'tokenMeter']

/** Translate one expected directive-compaction failure into a human outcome. */
function expectedDirectiveFailure(error: DirectiveCompactionError): CommandResult {
  switch (error.code) {
    case 'busy':
      return {
        kind: 'error',
        text: 'Directive compaction is unavailable while a turn is in progress; run it after the current turn settles.',
      }
    case 'cancelled':
      return { kind: 'error', text: 'Directive compaction cancelled.' }
    case 'summary':
      return {
        kind: 'error',
        text: 'Directive compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.',
      }
    case 'commit':
      return {
        kind: 'error',
        text: 'Directive compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.',
      }
  }
}

/** Drain-active wrapper shared by both command handlers. */
function draining(
  active: Set<Promise<CommandResult>>,
  run: (invocation: CommandInvocation) => Promise<CommandResult>,
): (invocation: CommandInvocation) => Promise<CommandResult> {
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = run(invocation)
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    void operation.then(retire, retire)
    return operation
  }
  return handler
}

/**
 * Register the `/compact-directive` and `/trim-directive` commands.
 * @param ctx - context carrying the command registry and seam services.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: CommandConfig = Config()): void {
  const active = new Set<Promise<CommandResult>>()
  const compactHandler = draining(active, (invocation) => (
    executeDirectiveCompact(ctx, invocation, config).catch((error: unknown): CommandResult => {
      if (error instanceof DirectiveCompactionError) return expectedDirectiveFailure(error)
      throw error
    })
  ))
  const trimHandler = draining(active, (invocation) => (
    executeTrim(ctx, invocation).catch((error: unknown): CommandResult => {
      if (error instanceof DirectiveCompactionError) return expectedDirectiveFailure(error)
      throw error
    })
  ))

  ctx.effect(function* () {
    // Yield drain before registration: composite teardown is LIFO, so no new
    // invocation can enter while already-started handler promises quiesce.
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      name: 'compact-directive',
      description: 'Compact the middle of the conversation per a natural-language requirement',
      input: { hint: 'What to keep and what to drop' },
      handler: compactHandler,
    })
    yield ctx.commands.register({
      name: 'trim-directive',
      description: 'Trim the whole conversation per a natural-language requirement, with no region protection',
      input: { hint: 'What to delete and what to keep' },
      handler: trimHandler,
    })
  }, 'dsh-directive-compact lifecycle')
}
