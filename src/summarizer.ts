/**
 * Directive-path summarization: the clean single-message LLM call that turns a
 * middle span of surface messages into one checkpoint, guided by the user's
 * directive layered over a four-point baseline.
 *
 * The call is ContextForge-style clean: one user message carrying the prompt
 * and a plain-text rendering of the span, with no system prompt, tools, or
 * conversation prefix — so it reuses no warm-prefix KV cache. That is the
 * explicit trade of cache reuse for a more focused summary.
 * @module @ya8d/dsh-directive-compact/summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, contentHasImage, createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  Message,
  TextBlock,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Resolved summarization target for one directive call. */
export interface DirectiveTarget {
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
}

/**
 * Safe summary plus the exact auxiliary-call envelope. Structurally identical
 * to the upstream seam's `SummaryResult` so callers can feed it to the
 * checkpoint protocol without importing a type the seam does not export.
 */
export type DirectiveSummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
} & (
  | { rawOutput: ContentBlock[]; llmStreamCall: true }
  | { rawOutput?: ContentBlock[]; llmStreamCall?: never }
)

/**
 * The role-prefix marker `renderSpan` emits before every block line and the
 * `FOUR_POINT_INSTRUCTION` "verbatim `[user]`" rule both depend on. Kept as a
 * named constant so the prompt contract and the renderer cannot drift apart:
 * changing the prefix here must update the prompt wording in the same change.
 */
const ROLE_PREFIX = (role: string): string => `[${role}] `

/**
 * The four-point baseline summarization instruction (ContextForge
 * `_SUMMARY_PROMPT`): task goal, key steps done, key findings, and next step,
 * plus verbatim preservation of every `[user]` original instruction.
 *
 * The `[user]` marker in point 5 is the exact prefix `renderSpan` emits for
 * user-role blocks (see {@link ROLE_PREFIX}); the two are a coupled contract.
 */
export const FOUR_POINT_INSTRUCTION =
  'Below is a fragment of an AI agent\'s conversation. Compress it into a structured "prior summary" the agent keeps consulting. You MUST preserve:\n'
  + '1. What the task goal is;\n'
  + '2. Which key steps were done (tools called, files changed);\n'
  + '3. Which key findings / facts / data were discovered;\n'
  + '4. What is not done yet and where to go next;\n'
  + '5. **Every original user instruction verbatim**: any line starting with `[user]` (the exact prefix `renderSpan` emits for user-role blocks) must be copied into the summary word for word, never paraphrased, summarized, or translated — the user\'s own words are the task anchor and rewriting drifts their meaning.\n'
  + 'Output only the summary text, no pleasantries. Here is the history:\n\n'

/**
 * Build the summarization prompt for one call: the directive layered over the
 * four-point baseline when present, or the baseline alone otherwise.
 * @param directive - the user's requirement, or `undefined` for a plain summary.
 * @returns the prompt prefix the span rendering is appended to.
 */
export function buildSummaryPrompt(directive: string | undefined): string {
  if (directive === undefined) return FOUR_POINT_INSTRUCTION
  return [
    `⚠️ This compaction has a user-specified special requirement; **follow it first**: ${directive}`,
    'While satisfying the above, the baseline information below must still be preserved.',
    '',
    FOUR_POINT_INSTRUCTION,
  ].join('\n')
}

/** Marker naming the directive, prepended to the logged and checkpointed summary. */
export function checkpointMarker(directive: string): string {
  return `[Directive-driven compaction checkpoint, per requirement: ${directive}]`
}

/** Guard stating that removed content is final, prepended to the checkpointed summary. */
export const CHECKPOINT_GUARD =
  'Important: this is the final compacted context. Content that was removed was removed on purpose — do not reconstruct, restore, or regenerate it.'

/**
 * Render one content block to a role-prefixed plain-text line.
 *
 * Reasoning blocks are rendered so the summarizer can see the model's
 * reasoning, but they never enter the final checkpoint: `summarizeWithDirective`
 * filters to `text` blocks only. A reasoning block inside a user message would
 * carry the `[user]` prefix and thus fall under the verbatim-preservation rule;
 * that is intentional — user-attributed content is the task anchor.
 */
function renderBlock(role: string, block: ContentBlock): string {
  const prefix = ROLE_PREFIX(role)
  switch (block.type) {
    case 'text':
      return `${prefix}${block.text}`
    case 'reasoning':
      return `${prefix}reasoning: ${block.text}`
    case 'tool-call':
      return `${prefix}called tool ${block.name} (${block.arguments})`
    case 'tool-result':
      return `${prefix}tool result:\n${block.content.map(nested => renderBlock('tool', nested)).join('\n')}`
    case 'image':
      return `${prefix}<image>`
    default:
      // Merge-extensible union: another plugin may have added a block type this
      // package does not render; keep a type tag so nothing is silently dropped.
      return `${prefix}<${String((block as { type: string }).type)}>`
  }
}

/**
 * Guard against rendering an unbounded middle span into one prompt. The
 * command layer (P3) sizes the middle via `planCompaction`, but the call must
 * fail loud rather than silently sending an oversized input to the model.
 */
const MAX_RENDERED_INPUT_CHARS = 4_000_000

/** Render a span of messages to plain text for the summarizer. */
export function renderSpan(messages: readonly Message[]): string {
  return messages
    .flatMap(message => message.content.map(block => renderBlock(message.role, block)))
    .join('\n')
}

/** Map a terminal summarization finish to its fail-closed error. */
function summarizationError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('directive summarization truncated at the token cap (incomplete summary)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/**
 * Run the directive-driven clean call: one user message, no prefix.
 * @param ctx - context providing the LLM service.
 * @param target - resolved provider/model/maxTokens.
 * @param messages - the span to summarize, in surface order.
 * @param directive - the user's compression requirement, or `undefined` for a
 *   plain four-point summary.
 * @param sessionId - the owning session, stamped for request routing.
 * @param signal - optional cancellation forwarded to the adapter.
 * @param promptBuilder - overrides the prompt prefix for the span; defaults to
 *   `buildSummaryPrompt`. The trim command passes `buildTrimPrompt` so the
 *   requirement is the sole instruction with no four-point baseline.
 * @param markerBuilder - overrides the directive marker prepended to the
 *   summary; defaults to `checkpointMarker`. The trim command passes
 *   `trimMarker` so the landed checkpoint identifies itself as a trim.
 * @param renderer - overrides how the span is rendered into the prompt;
 *   defaults to `renderSpan`. The operation-mode trim passes a numbered
 *   renderer so the model can reference nodes by seq.
 * @returns the safe text summary and the exact call envelope.
 */
export async function summarizeWithDirective(
  ctx: Context,
  target: DirectiveTarget,
  messages: readonly Message[],
  directive: string | undefined,
  sessionId: SessionId,
  signal?: AbortSignal,
  promptBuilder: (directive: string | undefined) => string = buildSummaryPrompt,
  markerBuilder: (directive: string) => string = checkpointMarker,
  renderer: (messages: readonly Message[]) => string = renderSpan,
): Promise<DirectiveSummaryResult> {
  const rendered = renderer(messages)
  if (rendered.length > MAX_RENDERED_INPUT_CHARS) {
    throw new Error(
      `directive summarization input too large (${rendered.length} rendered chars > ${MAX_RENDERED_INPUT_CHARS}); `
      + 'the span must be reduced before summarizing',
    )
  }
  const prompt = `${promptBuilder(directive)}${rendered}`
  const message = createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: 'dsh-directive-compact' },
  })
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages: [message],
    maxTokens: target.maxTokens,
    sessionId,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  }
  const assembler = new BlockAssembler()
  const startedAt = Date.now()
  let firstChunkAt: number | undefined
  for await (const chunk of ctx.llm.stream(options)) {
    if (firstChunkAt === undefined) firstChunkAt = Date.now()
    assembler.push(chunk)
  }
  const streamMs = Date.now() - startedAt
  const ttftMs = firstChunkAt === undefined ? streamMs : firstChunkAt - startedAt
  ctx.logger('dsh-directive-compact').debug(
    'directive summarization: first chunk in %dms, stream done in %dms',
    ttftMs, streamMs,
  )
  const finishError = summarizationError(assembler.finish)
  if (finishError !== undefined) throw finishError

  const rawOutput = assembler.blocks()
  if (contentHasImage(rawOutput)) {
    throw new LlmError('directive summarization cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  const textBlocks = rawOutput.filter((block): block is TextBlock => block.type === 'text')
  if (!textBlocks.some(block => block.text.trim().length > 0)) {
    throw new Error('directive summarization produced no text summary content')
  }
  const summary: ContentBlock[] = [
    ...(directive === undefined ? [] : [{ type: 'text' as const, text: markerBuilder(directive) }]),
    { type: 'text', text: CHECKPOINT_GUARD },
    ...textBlocks,
  ]
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: target.provider,
    model: target.model,
    maxTokens: target.maxTokens,
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
  }
}
