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
