# Agent Note: `/trim-directive` — AI natural-language trim

Status: implemented

## Problem

`/compact-directive` protects a fixed head (skeleton + `keepHeadUsers` turns) and a tail floor by design. A real-session test of "删除所有和ya8D/dsh-compaction-directive相关的context" showed the directive cannot honor deletion intent when the target content lives in the protected head: all 14 old-package mentions sat in the preserved region, so the checkpoint correctly summarized the middle but deleted nothing. Users need a command whose whole point is "cut this, keep that" with no dialogue-region protection.

An earlier P6 iteration shipped a keyword/regex hit-mapping trim (`compileTrimPattern` + `planTrim` + per-cluster `compaction/prune`). The user rejected that shape: the requirement is not a pattern match but a natural-language instruction. The trim must hand the conversation to the model and let the requirement decide what survives, ContextForge `compact_by_directive` style — without that path's head protection and without any degraded path.

## Decision

**`/trim-directive <requirement>` sends the ENTIRE surface to the model with a directive-only prompt, and replaces it with the model's output as one checkpoint.** No head, no tail, no system-node protection — full freedom (user-confirmed, P10).

### Full-freedom range

The trim range is the whole surface (`surface[0]..surface[last]`). The injected skeleton (`agent-instructions` / `system-prompt` / `skill-catalog`) and any `compact` checkpoint are trim-able like any other node. This is safe because:

- **The skeleton regenerates per request.** The agent loop re-injects system context on every step: `preStep` calls `systemPrompt.assemble()` and projects the result as a context message (agent-loop `agent.ts`), and `agent-instructions` composes its workspace instructions into `agent/pre-step` request messages. Deleting the surface copies does not remove the model's environment — the next request re-creates it.
- **A `compact` checkpoint's content survives in the append-only log**, recoverable by tooling.

An earlier design protected the skeleton (render + range exclusion after the last injected node); a real forked/compacted session showed that rule mis-located the trim start (a `compact` checkpoint at `surface[0]`, skeleton re-injected mid-conversation) and protected nodes that regenerate anyway. The only constraint kept is tool-pairing balance (`toolPairingBalancedBefore`/`After`), a session-integrity requirement — a replace cannot split a tool-call/result pair.

### Directive-only prompt

The prompt is `TRIM_INSTRUCTION` + the requirement verbatim + the rendered surface. There is no four-point baseline: unlike `/compact-directive`, the trim imposes no "keep task goal / findings / next step" floor — the user's requirement is the sole instruction (the ContextForge `compact_by_directive` shape). The requirement passes through unmodified; the model decides what survives.

### Summarizing lifecycle, not the model-free prune

A trim is a summarization transaction (one LLM call), so it uses the full lifecycle: `compaction/start` (standalone, `turn: null`) → `compaction/summary` → `user/message` replace (checkpoint source via `compactCheckpointSource`, `sourceEventSeqs` covering every shadowed node plus the start/summary seqs) → `compaction/end`. Failure closes the lifecycle with the error, mirroring `/compact-directive`. The earlier keyword design's `compaction/prune` shadow-price protocol is gone with it.

### Shrink validation

The framed checkpoint must be smaller than the shadowed span (mirror of the upstream convergence check); a larger or equal checkpoint fails with a `summary`-class error rather than landing a trim that grew the context.

### Balanced cuts

The trim range's boundaries must satisfy `toolPairingBalancedBefore` / `toolPairingBalancedAfter` so a tool-call/result pair is never split; the range expands outward until both hold, failing loud if no balanced cut exists.

## Alternatives considered

### Keyword/regex hit mapping with per-cluster prune

The first P6 iteration. Deterministic and testable, but it matches text literally — "delete everything about login" matches nothing unless the literal phrase appears, and a broad pattern can delete unrelated nodes. The user rejected it: the requirement is a natural-language instruction, not a pattern.

### Keep ContextForge's head protection (first user message always kept)

`compact_by_directive` preserves `messages[0]`. Rejected for full freedom: the trim's purpose is complete control, and the opening anchor is not structurally special once the skeleton regenerates per request.

### Protect the injected skeleton (render + range exclusion)

The original P6 design. Rejected after a real forked/compacted session: the rule started the trim after the LAST injected node, but automatic compaction folds the original skeleton into a `compact` checkpoint at `surface[0]` and the skeleton is re-injected mid-conversation — so the rule either missed trim-able dialogue or protected nodes that regenerate per request anyway (verified in agent-loop `preStep` and agent-instructions `agent/pre-step`).

## Consequences

The command is the second global command in the plugin, sharing the draining handler wrapper and error translation. A trim lands one summarize call and one lifecycle; the session log records the standard compaction events so the operation is reconstructable. Because the whole surface is trim-able down to nothing, a broad requirement can strip the session to just the checkpoint — the model's environment (skeleton) regenerates on the next request, and the stripped content stays recoverable in the append-only log. That is the point of the command, documented in the README.
