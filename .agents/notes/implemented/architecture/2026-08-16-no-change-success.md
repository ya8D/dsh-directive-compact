# Agent Note: no-change is a success, not a failure

Status: implemented

## Problem

"复杂对话 (1)" (`session-43a12820`): `/trim-directive 删除telemetry相关的内容` on a 199-node / ~178K-token surface opened `compaction/start` and produced no `compaction/summary`/`compaction/end` for 10+ minutes — the user abandoned the session. User hypothesis (confirmed against code): the session had no telemetry, so the model returned the context essentially verbatim; the near-verbatim rewrite then churned instead of finishing.

## Mechanism (two compounding factors)

1. **Under the pre-P10.1 single-chunk path** (200K budget), a ~178K-token input with a near-verbatim output could hit `MAX_TOKENS` (reasoning + ~178K output > the 256K per-call cap). `MAX_TOKENS` is a plain `LlmError`, not a `DirectiveCompactionError`, so `summarizeChunkWithRetry` retried it — 3 attempts, each several minutes of regeneration, 10-20 min total with no session events in between. That is the "一直重试" hang.
2. **Even without truncation**, the assembled checkpoint is never smaller than the shadowed span when the model keeps everything (marker + guard + `[part N/M]` headers add tokens), so shrink validation threw a `summary`-class `DirectiveCompactionError` — a failure for a case the user considers normal.

## Decision

**An unshrunk output is a normal no-change outcome, not a failure: record it, report it, and never retry or loop on a rewrite that cannot shrink.** The model's judgment ("nothing matches the requirement") is respected; the user gets a message and the conversation stays exactly as it was.

## Implementation

- Both commands append `compaction/summary` (recording the model's output, shadowed range, usage) BEFORE the shrink check, then:
  - checkpoint < shadowed → replace + `compaction/end` (existing path);
  - checkpoint >= shadowed → `compaction/end` with **no error**, info log `no change — checkpoint %d tokens >= shadowed %d tokens; surface untouched`, and a success result (`Nothing to trim: …` / `Nothing to compact: …`).
- Lifecycle legality verified in `compaction/invariant.ts`: a success `compaction/end` (no `error`) requires exactly one `compaction/summary`; it does NOT require a surface replace. So `start → summary → end` without a `user/message` replace is valid, and the surface stays untouched (no `surfaceOp` change).
- With P10.1's fixed 50K chunks, factor 1 is gone (per-chunk output ≤ ~50K + thinking fits the 256K cap); P10.3 removes factor 2. The two fixes together close the observed hang.

## Consequences

A trim/compact whose requirement matches nothing returns quickly with a clear message instead of a multi-minute churn or a spurious failure. The model output is still recorded in the lifecycle for auditing. Genuine failures (LLM errors, truncation after retries, commit failures) still close the lifecycle with `error` and surface as errors. One residual: when the requirement IS satisfiable but the model still fails to shrink, the user sees "nothing to trim" — the session trace and logs (P10.2) distinguish that from a true no-match.
