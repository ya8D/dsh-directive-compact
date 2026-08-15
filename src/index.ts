/**
 * Pure-incremental directive-driven compaction for DeepSeek Harness.
 *
 * Registers `/compact-directive <requirement>`: a global command that keeps the
 * session's fixed skeleton and the head/tail user turns, and summarizes the
 * middle span per the user's natural-language requirement. It does not inherit
 * `BasicCompactionEngine` and never registers `ctx.compaction`, so it coexists
 * with the upstream compaction backend unchanged.
 * @module @ya8d/dsh-directive-compact
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import { executeDirectiveCompact, DirectiveCompactionError, type CommandConfig } from './command.js'

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

/** Services the command needs: registry, session/message seam, LLM, and metering. */
export const inject = ['commands', 'sessions', 'llm', 'tokenMeter']

/**
 * Register the `/compact-directive` command.
 * @param ctx - context carrying the command registry and seam services.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: CommandConfig = Config()): void {
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = executeDirectiveCompact(ctx, invocation, config)
      .catch((error: unknown): CommandResult => {
        // Expected failures become concise human-only outcomes; anything else
        // rejects the handler so the command executor reports it.
        if (error instanceof DirectiveCompactionError) {
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
        throw error
      })
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    // Yield drain before registration: composite teardown is LIFO, so no new
    // invocation can enter while already-started handler promises quiesce.
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      name: 'compact-directive',
      description: 'Compact the middle of the conversation per a natural-language requirement',
      input: { hint: 'What to keep and what to drop' },
      handler,
    })
  }, 'dsh-directive-compact lifecycle')
}
