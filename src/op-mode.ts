/**
 * P11 operation-mode trim: the model outputs an OPERATION MANIFEST over
 * numbered surface nodes instead of regenerating the whole context; the plugin
 * executes the manifest programmatically. Kept nodes splice verbatim (zero
 * generation, 100% fidelity — no drift, no hallucination); only rewrite and
 * summarize content is model-generated.
 *
 * Input rendering numbers every node with its GLOBAL event seq (reused from
 * the harness: sessions natively carry seq, `tool-session-query` already
 * references events as `seq N`, and real users have issued trims like "delete
 * seq 1344493"). Node-start lines are `[seq <N>] [role] …`; in-node
 * continuation lines are indented two spaces. The numbering exists only on the
 * input side — the checkpoint splices the unnumbered original rendering.
 *
 * Output is a strict one-operation-per-line manifest from the first column:
 * `delete: 28039, 28045` (list/ranges), `rewrite: 28039` + `---content---` …
 * `---end---` (that node's full replacement), `summarize: 28040-28045` +
 * content block (a summary replacing the range), or exactly
 * `<<NO_CHANGE>>`/empty for no change. ANY parse or validation uncertainty
 * falls back to the existing rewrite mode — never half-executed.
 * @module @ya8d/dsh-directive-compact/op-mode
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { Message } from '@deepseek-ai/dsh-llm'
import { renderSpan } from './summarizer.js'
import { TRIM_NO_CHANGE_MARKER } from './trim.js'

/** One operation-manifest entry replacing a node range with a summary. */
export interface OpSummarize {
  /** First seq of the replaced range (in chunk order). */
  readonly start: number
  /** Last seq of the replaced range (in chunk order). */
  readonly end: number
  /** The model's summary text replacing the whole range. */
  readonly summary: string
}

/** Parsed operation manifest: every referenced seq is a surface node seq. */
export interface OpManifest {
  /** Whole nodes to drop (verbatim content does not enter the checkpoint). */
  readonly deletes: readonly number[]
  /** Node seq → its full replacement content (plugin re-adds the role prefix). */
  readonly rewrites: ReadonlyMap<number, string>
  /** Node ranges replaced by one summary each. */
  readonly summarizes: readonly OpSummarize[]
}

/** Parse outcome: a valid manifest, a no-change, or a reject reason. */
export type OpParse =
  | { readonly kind: 'manifest'; readonly manifest: OpManifest }
  | { readonly kind: 'no-change' }
  | { readonly kind: 'invalid'; readonly reason: string }

/** Content-block delimiter lines framing rewrite/summarize text. */
const CONTENT_OPEN = '---content---'
const CONTENT_CLOSE = '---end---'

/**
 * Render numbered nodes for the operation-mode prompt. Node-start lines carry
 * the global seq (`[seq 28039] [user] …`); in-node continuation lines are
 * indented two spaces so the model can tell node boundaries from in-node
 * blocks. Only used on the input side; the checkpoint splices the unnumbered
 * original rendering.
 * @param seqs - surface seqs of the chunk, in surface order.
 * @param messagesBySeq - derived message per seq (absent seqs render nothing).
 * @returns the numbered, role-prefixed plain-text rendering.
 */
export function renderSpanNumbered(
  seqs: readonly number[],
  messagesBySeq: ReadonlyMap<number, Message>,
): string {
  return seqs.map((seq) => {
    const message = messagesBySeq.get(seq)
    if (message === undefined) return ''
    const lines = renderSpan([message]).split('\n')
    const [first, ...rest] = lines
    return [`[seq ${seq}] ${first}`, ...rest.map(line => `  ${line}`)].join('\n')
  }).join('\n')
}

/**
 * Build the operation-mode prompt: the directive is the sole instruction, the
 * model replies ONLY with an operation manifest over the numbered nodes.
 * @param directive - the user's trim requirement; the command layer rejects an
 *   empty input before this is called, so `undefined` here is unreachable and
 *   fails loud rather than trimming without an instruction.
 * @returns the prompt prefix the numbered rendering is appended to.
 */
export function buildOpModePrompt(directive: string | undefined): string {
  if (directive === undefined || directive.length === 0) {
    throw new Error('operation-mode trim requires a non-empty requirement')
  }
  return 'Below is the current conversation context of an AI agent, split into numbered nodes. '
    + 'Each node starts with [seq <N>] followed by its role; continuation lines are indented two spaces. '
    + 'Apply the user\'s trim requirement by outputting an OPERATION MANIFEST, one operation per line, from the first column:\n'
    + '- `delete: <seq list>` — remove whole nodes (comma-separated seqs; ranges like 28040-28045 allowed)\n'
    + '- `rewrite: <seq>` — replace ONE node\'s content with your own text\n'
    + '- `summarize: <seq range>` — replace a range of nodes with a short summary\n'
    + 'For rewrite and summarize, put the replacement text between `---content---` and `---end---` lines directly after the operation line. '
    + 'If the requirement changes NOTHING, output exactly this line and nothing else: `<<NO_CHANGE>>`\n'
    + 'Output only the manifest — no prose, no explanations, no tools. Here is the requirement:\n\n'
    + `${directive}\n\nHere is the context:\n\n`
}

/**
 * Parse one chunk call's text output into an operation manifest.
 *
 * Grammar (line-based, operation lines from the first column):
 * - `delete: N, M, A-B` — one or more seqs/ranges
 * - `rewrite: N` — must be followed by a content block
 * - `summarize: A-B` (or `summarize: N`) — must be followed by a content block
 * - content block: `---content---` … `---end---`, anything in between kept
 *   verbatim (including blank lines); the block content must be non-empty
 * - `<<NO_CHANGE>>` alone, or empty output — no change
 * Anything else (prose, unknown operation lines, unpaired delimiters, a marker
 * mixed with operations) is invalid and the caller falls back to rewrite mode.
 * @param text - the model's raw text output for one chunk.
 * @returns the parsed outcome.
 */
export function parseOpManifest(text: string): OpParse {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed === TRIM_NO_CHANGE_MARKER) return { kind: 'no-change' }

  const deletes: number[] = []
  const rewrites = new Map<number, string>()
  const summarizes: OpSummarize[] = []
  let pending: { op: 'rewrite' | 'summarize'; start: number; end: number } | null = null
  let content: string[] | null = null

  const lines = text.split('\n')
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (content !== null) {
      // The opening delimiter line directly follows the rewrite/summarize
      // line; it is framing, never content.
      if (line.trim() === CONTENT_OPEN) continue
      if (line.trim() === CONTENT_CLOSE) {
        if (pending === null) return { kind: 'invalid', reason: 'content block without a preceding rewrite/summarize line' }
        const body = content.join('\n').trim()
        if (body.length === 0) return { kind: 'invalid', reason: 'empty content block' }
        if (pending.op === 'rewrite') {
          if (pending.start !== pending.end) return { kind: 'invalid', reason: 'rewrite must target exactly one seq' }
          rewrites.set(pending.start, body)
        } else {
          summarizes.push({ start: pending.start, end: pending.end, summary: body })
        }
        pending = null
        content = null
      } else {
        content.push(line)
      }
      continue
    }
    if (line.trim().length === 0) continue
    if (line.trim() === TRIM_NO_CHANGE_MARKER) {
      return { kind: 'invalid', reason: 'no-change marker mixed with operations' }
    }
    if (line.trim() === CONTENT_OPEN) return { kind: 'invalid', reason: 'content block without a preceding rewrite/summarize line' }
    if (line.trim() === CONTENT_CLOSE) return { kind: 'invalid', reason: 'content block end without a start' }
    if (line[0] !== undefined && /[ \t]/.test(line[0]!)) {
      return { kind: 'invalid', reason: 'operation line must start at the first column' }
    }
    const deleteMatch = /^delete:\s*(.+)$/.exec(line)
    if (deleteMatch !== null) {
      const seqs = parseSeqList(deleteMatch[1]!)
      if (seqs === null) return { kind: 'invalid', reason: `malformed delete list: ${deleteMatch[1]}` }
      deletes.push(...seqs)
      continue
    }
    const rewriteMatch = /^rewrite:\s*(\d+)$/.exec(line)
    if (rewriteMatch !== null) {
      if (pending !== null) return { kind: 'invalid', reason: 'rewrite/summarize without its content block' }
      pending = { op: 'rewrite', start: Number(rewriteMatch[1]!), end: Number(rewriteMatch[1]!) }
      content = []
      continue
    }
    const summarizeMatch = /^summarize:\s*(\d+)(?:-(\d+))?$/.exec(line)
    if (summarizeMatch !== null) {
      if (pending !== null) return { kind: 'invalid', reason: 'rewrite/summarize without its content block' }
      const start = Number(summarizeMatch[1]!)
      const end = summarizeMatch[2] === undefined ? start : Number(summarizeMatch[2]!)
      if (start > end) return { kind: 'invalid', reason: `summarize range inverted: ${start}-${end}` }
      pending = { op: 'summarize', start, end }
      content = []
      continue
    }
    return { kind: 'invalid', reason: `unrecognized line: ${line.slice(0, 60)}` }
  }
  if (content !== null) return { kind: 'invalid', reason: 'unterminated content block' }
  if (pending !== null) return { kind: 'invalid', reason: 'rewrite/summarize without its content block' }
  if (deletes.length === 0 && rewrites.size === 0 && summarizes.length === 0) return { kind: 'no-change' }
  return { kind: 'manifest', manifest: { deletes, rewrites, summarizes } }
}

/**
 * Validate a parsed manifest against its chunk and the session's tool-pairing
 * balance.
 *
 * Rules: every referenced seq must be a member of the chunk; delete/rewrite/
 * summarize must not overlap; a summarize range is interpreted as the chunk
 * nodes between its boundary seqs in surface order (boundary seqs must exist);
 * every handled run (contiguous chunk nodes covered by operations) must have
 * tool-pairing-balanced boundary cuts — a tool call and its result either both
 * sit inside the handled run or both stay outside, so operations can never
 * split a pair.
 * @param manifest - parsed manifest to check.
 * @param chunkSeqs - the chunk's surface seqs, in surface order.
 * @param session - session providing tool-pairing balance.
 * @returns a reject reason, or null when the manifest is executable.
 */
export function validateOpManifest(
  manifest: OpManifest,
  chunkSeqs: readonly number[],
  session: Session,
): string | null {
  const members = new Set(chunkSeqs)
  const handled = new Set<number>()
  const reject = (reason: string): string => reason
  for (const seq of manifest.deletes) {
    if (!members.has(seq)) return reject(`seq ${seq} is not in this chunk`)
    if (handled.has(seq)) return reject(`operation overlap on seq ${seq}`)
    handled.add(seq)
  }
  for (const seq of manifest.rewrites.keys()) {
    if (!members.has(seq)) return reject(`seq ${seq} is not in this chunk`)
    if (handled.has(seq)) return reject(`operation overlap on seq ${seq}`)
    handled.add(seq)
  }
  for (const range of manifest.summarizes) {
    const startIdx = chunkSeqs.indexOf(range.start)
    const endIdx = chunkSeqs.indexOf(range.end)
    if (startIdx === -1) return reject(`seq ${range.start} is not in this chunk`)
    if (endIdx === -1) return reject(`seq ${range.end} is not in this chunk`)
    if (startIdx > endIdx) return reject(`summarize range inverted: ${range.start}-${range.end}`)
    for (const seq of chunkSeqs.slice(startIdx, endIdx + 1)) {
      if (handled.has(seq)) return reject(`operation overlap on seq ${seq}`)
      handled.add(seq)
    }
  }

  // Every handled run must start and end on tool-pairing-balanced cuts.
  let index = 0
  while (index < chunkSeqs.length) {
    if (!handled.has(chunkSeqs[index]!)) {
      index += 1
      continue
    }
    const start = chunkSeqs[index]!
    let endIndex = index
    while (endIndex + 1 < chunkSeqs.length && handled.has(chunkSeqs[endIndex + 1]!)) endIndex += 1
    const end = chunkSeqs[endIndex]!
    try {
      if (!toolPairingBalancedBefore(session, start)) {
        return reject(`operations starting at seq ${start} split a tool call/result pair`)
      }
      if (!toolPairingBalancedAfter(session, end)) {
        return reject(`operations ending at seq ${end} split a tool call/result pair`)
      }
    } catch (error: unknown) {
      return reject(`tool-pairing check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    index = endIndex + 1
  }
  return null
}

/**
 * Execute a manifest over one chunk: splice kept nodes verbatim (role-prefixed
 * original rendering), replace rewrite nodes with the model's content (plugin
 * re-adds the node's role prefix), replace summarize ranges with their summary
 * text, and skip deleted nodes. A null manifest (no change) splices the whole
 * chunk verbatim.
 * @param manifest - validated manifest, or null for no-change.
 * @param chunkSeqs - the chunk's surface seqs, in surface order.
 * @param session - session whose events project the node messages.
 * @returns the chunk's checkpoint text (marker/part headers added by the caller).
 */
export function executeOpManifest(
  manifest: OpManifest | null,
  chunkSeqs: readonly number[],
  session: Session,
): string {
  const messagesBySeq = new Map<number, Message>()
  for (const seq of chunkSeqs) {
    const event = session.events[seq]
    const message = event === undefined ? null : session.deriveEventMessage(event)
    if (message !== null) messagesBySeq.set(seq, message)
  }
  const deletes = new Set(manifest?.deletes ?? [])
  const rewrites = manifest?.rewrites ?? new Map<number, string>()
  const summarizeRanges = (manifest?.summarizes ?? []).map((range) => {
    const startIdx = chunkSeqs.indexOf(range.start)
    const endIdx = chunkSeqs.indexOf(range.end)
    return { seqs: new Set(chunkSeqs.slice(startIdx, endIdx + 1)), summary: range.summary }
  })
  const summarized = new Set<number>()

  const parts: string[] = []
  for (const seq of chunkSeqs) {
    if (deletes.has(seq)) continue
    const rewrite = rewrites.get(seq)
    if (rewrite !== undefined) {
      const message = messagesBySeq.get(seq)
      const role = message === undefined ? '' : `[${message.role}] `
      parts.push(`${role}${rewrite}`)
      continue
    }
    const range = summarizeRanges.find(candidate => candidate.seqs.has(seq))
    if (range !== undefined) {
      if (!summarized.has(seq)) {
        // A summary replaces a RANGE of nodes, so it belongs to no single node
        // role — unlike rewrite (single node, role prefix re-added) it is
        // inserted bare. Deliberate: the checkpoint lands as one user message,
        // so no role ambiguity arises.
        parts.push(range.summary)
        for (const covered of range.seqs) summarized.add(covered)
      }
      continue
    }
    const message = messagesBySeq.get(seq)
    if (message !== undefined) parts.push(renderSpan([message]))
  }
  return parts.join('\n')
}

/** Parse a comma-separated seq list with `A-B` ranges into flat seq numbers. */
function parseSeqList(value: string): number[] | null {
  const parts = value.split(',').map(part => part.trim())
  if (parts.length === 0 || parts.some(part => part.length === 0)) return null
  const seqs: number[] = []
  for (const part of parts) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (match === null) return null
    const start = Number(match[1]!)
    const end = match[2] === undefined ? start : Number(match[2]!)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null
    for (let seq = start; seq <= end; seq += 1) seqs.push(seq)
  }
  return seqs
}
