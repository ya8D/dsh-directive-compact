# Agent Note: budgeted chunked trim (`/trim-directive` large-surface path)

Status: implemented

## Revision (2026-08-16): fixed 50K chunk budget

The window-derived chunk numbers below (`per-chunk input = floor(W/5) = 200K`, `max chunks = 10`) are **superseded**: the plugin targets the 1M-window DeepSeek models, so the chunk size is now fixed rather than derived.

- **Per-chunk input = 50K heuristic tokens** (~200K rendered chars at the meter's 4 chars/token). Motivation (user-verified on "复杂对话 (1)", `session-43a12820`): `/trim-directive 删除telemetry相关的内容` on a 199-node / ~178K-token surface — a single call under the old 200K budget — opened `compaction/start` and produced no summary/end for 10+ minutes (hung on the one large call). 50K chunks split that session into 4 parallel calls, each ~4× smaller and independently retriable.
- **Max chunks = 20** (20 × 50K = 1M = the full window). `chunkTrimNodes` fails loud beyond it ("compact the session first").
- **Execution stays full-parallel** (no artificial concurrency cap; up to 20 `ctx.llm.stream()` calls). Re-verified against dsh source: no llm-layer concurrency limiter exists; HTTP 429 is handled by the adapter's retryPolicy plus the per-chunk 3-attempt retry. CJK safety: the meter prices 4 chars/token, which UNDERCOUNTS Chinese (real tokenizers are ~1-1.5 chars/token), so a 50K-heuristic chunk can be ~150K real input tokens; input + the 256K output cap stays ≤ the 1M window, and the ~200K rendered chars are far under the summarizer's 4M-char guard.
- `resolveTrimBudget` returns `{ maxTokens: min(window/2, adapterMax), chunkInputBudget: 50_000, maxChunks: 20 }`. The chunking algorithm (`chunkTrimNodes`) is unchanged — first-fit accumulation to the budget with roll-back to the balanced boundary ("首次超过 50K 就分片" is that behavior with the new constant).

## Problem

`/trim-directive` hands the whole trim-able dialogue to the model in one call. A real GUI run failed with `directive summarization truncated at the token cap`: the fixture surface rendered enough input that the model's reasoning ate the 8192-token output budget before the trimmed output finished. The one-shot design had no bound tying the summarization call to the routed model's actual context window — a large or pathological surface could overflow the request or truncate the response.

## Decision

**Bound every trim summarization call to the routed model's window, and slice oversized input into parallel budget-sized chunks assembled into one checkpoint.**

### The window and every derived number

The window is `ctx.llm.resolveModelInfo(provider, model).context.contextWindow` — dsh's `LlmModelContext.contextWindow`, documented as the **maximum combined request and response context in tokens** (llm/types.ts). deepseek-v4-flash reports 1,000,000. All budget constants derive from it (`resolveTrimBudget`):

- **Output cap maxTokens** = `min(floor(W/2), adapterMaxTokens)` = `min(500K, 256K)` = 256K. Half the window for the response, but never above the adapter's hard per-response cap (`DEFAULT_MAX_TOKENS = 256_000` in llm-deepseek). Reasoning tokens COUNT toward this cap (`completion_tokens_details.reasoning_tokens`), so thinking eats into the 256K — the model's own trade, not a configured split. At most ~56K of thinking leaves ≥200K of output, matching the 200K chunk input so the model can rewrite what it reads.
- **Per-chunk input budget** = `floor(W/5)` = 200K. A chunk occupies input (≤200K) + output (≤256K) ≤ 456K < W, leaving ~544K headroom for token-meter estimation error and request overhead.
- **Max chunks** = 10. Worst-case fragmentation bound over the real 1,000,000-token window (decimal, per DeepSeek's spec — NOT 2²⁰): a single very large node (e.g. ~101K, over half the 200K budget) can fill a chunk alone, so 10 chunks cover the full window (`ceil(1M / 101K) = 10`); the final partial chunk rides on an earlier chunk's headroom, never adding an extra chunk. More would mean total input > W, which the model cannot read anyway — `chunkTrimNodes` fails loud (`compact the session first`) when total input exceeds `chunks × budget`.

### Chunking

- **Unit**: `ctx.tokenMeter.measure(session).nodes[].tokens` — the same per-node heuristic prices upstream `selectCompactableRange` slices on.
- **Cut points**: accumulate per-node tokens; at the budget boundary, roll the cut back to `toolPairingBalancedBefore` so a tool-call/result pair is never split (the upstream balance loop). A single node larger than the budget is taken whole (it cannot be split) rather than looping forever.
- **Execution**: all chunks summarized in parallel (`Promise.all`). `ctx.llm.stream()` per call is an independent async generator with no shared session state, so concurrency is safe; HTTP 429 rate limits are retried by the adapter's retryPolicy — no artificial concurrency cap.

### Assembly

One `user/message` replace over the whole trim range. The head marker (`trimMarker`) and the guard (`CHECKPOINT_GUARD`) appear once; each chunk's text output is appended under a `[part N/M]` divider, with per-chunk marker/guard repeats stripped. Token usage is merged across chunks. Shrink validation compares the assembled checkpoint against the total shadowed span.

## Alternatives considered

### Keep the single-call design, raise maxTokens

Raising 8192 → 16384/32000 helps small surfaces but does not bound the input: a huge render can still overflow the request, and reasoning can still eat an unbounded share of any output cap. No guarantee, just more headroom.

### `reasoningEffort: 'off'` to free output budget

Rejected after reading `llm-deepseek/serialize.ts`: `'off'` maps to `thinking: 'disabled'` — it disables reasoning entirely, not "less thinking". The trim's cut decisions benefit from reasoning; the real fix is budget headroom, not disabling thought.

### Serial chunks

Token cost is identical to parallel; parallel is faster. The only parallel risks are 429 rate limits (handled by the adapter) and assembly order (handled by deterministic `[part N/M]` ordering from the chunk list).

## Consequences

A trim is now bounded: any surface the session can hold (≤ window) can be trimmed without overflowing a request or truncating a response. Large conversations split into up to 10 parallel summarization calls; the assembled checkpoint stays one replacement node, so the session lifecycle (`compaction/start`/`summary`/`end`) and surface integrity rules are unchanged. Total input beyond the window fails loud with a directive to compact first.
