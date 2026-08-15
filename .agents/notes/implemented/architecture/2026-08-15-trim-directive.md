# Agent Note: `/trim-directive` — AI natural-language trim

Status: implemented

## Problem

`/compact-directive` protects a fixed head (skeleton + `keepHeadUsers` turns) and a tail floor by design. A real-session test of "删除所有和ya8D/dsh-compaction-directive相关的context" showed the directive cannot honor deletion intent when the target content lives in the protected head: all 14 old-package mentions sat in the preserved region, so the checkpoint correctly summarized the middle but deleted nothing. Users need a command whose whole point is "cut this, keep that" with no dialogue-region protection.

An earlier P6 iteration shipped a keyword/regex hit-mapping trim (`compileTrimPattern` + `planTrim` + per-cluster `compaction/prune`). The user rejected that shape: the requirement is not a pattern match but a natural-language instruction. The trim must hand the conversation to the model and let the requirement decide what survives, ContextForge `compact_by_directive` style — without that path's head protection and without any degraded path.

## Decision

**`/trim-directive <requirement>` sends the trim-able conversation to the model with a directive-only prompt, and replaces the whole trim range with the model's output as one checkpoint.** No head, no tail, no dialogue-region protection.

### The trim range: after the injected system nodes

A DeepSeek Harness session opens with the first user message followed by the injected `agent-instructions` / `system-prompt` / `skill-catalog` nodes; they are injected once, are never re-injected after a replacement, and carry the model's environment. They are session machinery, not dialogue, so they must survive a trim. Because a surface `replace` shadows one contiguous range and the injected nodes sit between the first user message and the rest of the conversation, the only range that keeps every injected node outside the replacement is the span **after the last injected node** through the surface tail. The opening anchor (first user message) stays outside the range as a structural consequence of that contiguity, not as a protection policy.

Three guards keep system nodes out of harm's way:
1. **Render exclusion** — the prompt text is built only from nodes after the last injected node (`isInjectedSystemNode` classifies `user/message` events whose source kind is not `user`).
2. **Range exclusion** — the `replace` starts at the first node after the last injected node.
3. **Session validation backstop** — if a range ever did cover an uncovered injected node, `sourceEventSeqs` would omit it and the session's append validation fails loud (`must include every shadowed surface node`).

### Directive-only prompt

The prompt is `TRIM_INSTRUCTION` + the requirement verbatim + the rendered dialogue. There is no four-point baseline: unlike `/compact-directive`, the trim imposes no "keep task goal / findings / next step" floor — the user's requirement is the sole instruction (the ContextForge `compact_by_directive` shape). The requirement passes through unmodified; the model decides what survives.

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

`compact_by_directive` preserves `messages[0]`. Here the opening anchor is preserved anyway as the structural consequence of the system-node range exclusion, but the trim makes no *additional* head guarantee and no tail guarantee — the entire post-skeleton conversation is trim-able.

### Whole-surface replace including injected nodes

Replacing the injected nodes with the model's output would make the next request lose the system prompt, tool catalog, and skill list — and they are not re-injected. Rejected on the model-visible ⟺ reconstructable principle.

## Consequences

The command is the second global command in the plugin, sharing the draining handler wrapper and error translation. A trim lands one summarize call and one lifecycle; the session log records the standard compaction events so the operation is reconstructable. Because the dialogue is trim-able down to nothing (only the injected skeleton and the checkpoint remain), a broad requirement can strip the task anchor — that is the point of the command, documented in the README.
