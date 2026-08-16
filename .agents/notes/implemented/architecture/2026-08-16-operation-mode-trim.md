# Agent Note: operation-mode trim (model decides, plugin executes)

Status: implemented

## Problem

Rewrite-mode trim's root cost is "output ≈ input": the model must decode ALL kept content for every chunk that changes anything. Real anchor "复杂对话3": 9 chunks / 362,509 ms / ~560K output tokens — and every kept byte passes through the model's hands (verbatim rule protects only `[user]`; assistant/tool content can drift or lose facts). The `<<NO_CHANGE>>` status value only covers the all-or-nothing edge.

## Decision

**Operation mode: the model outputs a small operation manifest over numbered nodes; the plugin executes it programmatically.** Kept nodes splice verbatim (zero generation — 100% fidelity), deleted nodes drop, rewritten nodes take the model's content, summarized ranges take the summary. Any parse/validation uncertainty falls back to the existing rewrite mode — never half-executed.

## Format (user-confirmed, deep-dived)

- **Input**: numbered rendering `[seq <global-seq>] [role] …` — reuses the harness's global event seq (no invented ordinals, no mapping; `tool-session-query` already references events as `seq N`; a real user issued "delete seq 1344493 …"). In-node continuation lines indent two spaces. Numbering is input-side only; the checkpoint splices unnumbered originals.
- **Output** (one operation per line, from the first column): `delete: 28039, 28045` (list/ranges), `rewrite: 28039` + `---content---`…`---end---` (that node's full replacement — the model must supply the complete new content, not a change description), `summarize: 28040-28045` + content block, or `<<NO_CHANGE>>`/empty. Rewrite covers "delete part of a node" — the node-level delete cannot express partial removal. Speedup depends on mention concentration: concentrated → near-zero generation; scattered → rewrite most touched nodes (the semantic cost of scattered deletion itself).
- **Validation** (correctness first): seq ∈ chunk; no delete/rewrite/summarize overlap; summarize range = chunk nodes between its boundary seqs; every handled run must start/end on `toolPairingBalancedBefore/After` cuts — a tool call and its result either both sit inside a handled run or both stay outside, so operations can never split a pair (this replaces a per-node pairing lookup, which dsh does not expose).

## Implementation

- `src/op-mode.ts` — `renderSpanNumbered`, `buildOpModePrompt`, `parseOpManifest` (strict line grammar, content blocks), `validateOpManifest` (membership/overlap/tool-pair boundary balance), `executeOpManifest` (verbatim splice + rewrite with re-added role prefix + summarize + delete).
- `src/command-trim.ts` — every chunk runs the op-mode call first; a valid manifest executes, a no-change chunk keeps its original rendering, anything else falls back to the rewrite-mode call (both calls' usage merged). `summarizeChunkWithRetry` gained promptBuilder/markerBuilder/renderer; `summarizeWithDirective` gained a renderer parameter.
- Rewrite/summarize content blocks are pure content; the plugin re-adds the node's role prefix (`[user] `/`[assistant] `) for format consistency with untouched nodes.

## Consequences

A trim that touches a few nodes of a large session no longer pays for regenerating the ~350K tokens that stay the same; kept content is byte-identical to the original (no drift, no hallucination); deletion decisions are visible in the manifest and auditable. Costs: a second LLM call per chunk when the model does not cooperate (prose fallback); rewrite nodes still pass through the model's hands (scoped to the touched nodes); batch-rewrite directives degrade to rewrite mode. Remaining work: real-session verification of the speedup vs the 362 s baseline and fidelity (verbatim match of kept nodes), and prompt calibration if the model under-declares.
