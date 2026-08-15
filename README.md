# @ya8d/dsh-directive-compact

A customized natural-language compaction plugin. It gives you the ability to precisely trim context — sometimes even to fix a malfunctioning context.

**Designed for large-context models (1,000,000-token window, e.g. deepseek-v4-flash).** The chunking budget is derived from the routed model's window (see [How it works](#how-it-works)); the numbers below assume the 1M window.

It registers two global commands for DeepSeek Harness:

- `/compact-directive <requirement>` — keeps the session's fixed skeleton head (the first user message plus the injected `agent-instructions` / `system-prompt` / `skill-catalog` nodes) and the recent turns verbatim, and summarizes only the middle span according to your natural-language requirement — so an aggressive directive like "delete everything about doc" trims what you asked for without erasing the task anchor the model needs to keep working.
- `/trim-directive <requirement>` — hands the whole conversation to the model and trims it per your natural-language requirement, with **zero dialogue-region protection**. This is the escape hatch when the directive must reach protected content: "delete all context about X" works even when X lives in the head, because trim has no head.

> **⚠️ Recommended: use in a forked session.** A trim permanently removes the trimmed content from the model-visible surface: no undo in the UI, no minimum retention. The original text is NOT lost — the session log is append-only, so every trimmed node survives in `session.events` and the replace event records its exact seqs (`shadowedSeqs`/`sourceEventSeqs`) — but recovering it requires tooling; the conversation UI offers no restore. For destructive experiments, fork the session first.

## Install

Install into a profile with the dsh CLI. `dsh plugin` forwards to pnpm in the profile directory, so a published package, a local checkout, or a tarball all work:

```sh
dsh plugin --profile <name> add @ya8d/dsh-directive-compact    # from the npm registry
dsh plugin --profile <name> add ./dsh-directive-compact         # from a local checkout
dsh plugin --profile <name> add ./dsh-directive-compact-0.1.0.tgz  # from a tarball
```

The package declares `dsh.bundle`, so `dsh plugin` activates its `cordis.patch.yml` layer automatically. The patch inserts this plugin's row; it disables nothing from the upstream composition.

`dsh plugin --profile <name> remove @ya8d/dsh-directive-compact` removes both the dependency and the layer.

> **Pure increment.** This plugin never touches `ctx.compaction`: it does not inherit `BasicCompactionEngine`, does not register the `compaction` single slot, and registers no automatic-compaction listeners. The upstream backend and `/compact` command stay exactly as they are; this plugin only adds two commands.

## Testing

Two commands, two suites:

- `npm test` — the unit suite (`tests/**/*.spec.ts`): planning, summarization, both command transactions, and the Loader composition. Needs no network or credentials.
- `npm run test:e2e` — the with-key e2e (`tests/directive-compact.e2e.ts`): one real directive-driven compaction against the DeepSeek public API. The e2e file is collected only under this command; `npm test` does not load it. The key resolves from `$DEEPSEEK_API_KEY`, then from the Harness credentials document at `$DSH_HOME/.credentials.yaml`, and the suite self-skips when neither supplies one.

## Command

- `/compact-directive <requirement>` — compact the middle of the conversation per your natural-language requirement, keeping the session head and the recent turns verbatim. The requirement is required: an empty invocation returns a usage error pointing at `/compact`, which is the plain (no-requirement) summarization command.
- `/trim-directive <requirement>` — hand the whole conversation to the model and trim it per your natural-language requirement. No dialogue region is protected: the requirement alone decides what survives, down to nothing.

> **Commands are log-only, not dialogue.** Like every dsh slash command (including upstream `/compact`), `/compact-directive` and `/trim-directive` do not appear as messages in the conversation UI — `command/run` / `command/done` are log-only session events (`never model surface`), and the effect they asked for lands as the checkpoint instead. The full invocation, its result, and the compaction lifecycle are visible in the session trace/log, not the chat transcript.

> **The original dialogue stays visible after a trim.** The UI conversation flow renders only append-origin messages; a trim/compaction checkpoint is a replacement that stays model-only by dsh design (the transcript never erases what the user already saw — upstream `/compact` behaves the same). The model's next request uses the checkpointed context; to verify the trim's effect, read the session trace (checkpoint + lifecycle) rather than the chat transcript.

The compact-directive requirement is plain free text. Prefer a positive frame ("keep / focus / downweight") over a negative one ("delete everything with …", "never appear"): aggressively negative phrasing reads as systematic record-removal and can trip the summarizer's safety refusal even when the intent is innocuous. The instruction is also passed through the model's ordinary safety judgment, so the same framing advice applies.

The trim-directive requirement is also plain free text ("delete everything about doc, keep only the login flow"). The model applies it directly with a directive-only prompt — no summarization baseline is layered on top, so the requirement is honored as written. The injected system nodes (`agent-instructions` / `system-prompt` / `skill-catalog`) are never trim-able: they are session machinery, not dialogue, and are kept outside both the prompt and the replaced range.

## How it works

### `/compact-directive`

The compaction keeps the fixed-skeleton head and the recent turns verbatim, and replaces the middle span with one checkpoint message. The summarization prompt layers your directive on top of a four-point baseline — task goal, key steps done, key findings, and next step — and requires every `[user]` original instruction to be preserved verbatim. The tail always covers the last user utterance and everything after it (an in-flight assistant stream or unpaired tool call survives), and `keepHeadUsers` / `keepTailUsers` extend the preserved regions further back. A shrink check rejects a checkpoint that is not smaller than the span it replaces (mirror of the upstream convergence check); the attempt is recorded in the session log and the conversation is unchanged.

The head is the session's fixed skeleton, not merely the first message: every DeepSeek Harness session opens with the same four nodes — the user's first message, the `agent-instructions` injection, the `system-prompt` snapshot, and the `skill-catalog` listing. These four nodes appear once at session start, are not re-injected per turn, and are not restored after a replacement, so they are preserved.

### `/trim-directive`

The trim renders the trim-able dialogue (everything after the injected system nodes) and sends it to the model with a directive-only prompt. The model's output replaces the whole trim range as one checkpoint through the standard summarizing lifecycle — `compaction/start` (standalone) → `compaction/summary` → `user/message` replace → `compaction/end`. A shrink check rejects a checkpoint that is not smaller than the span it replaces, and the range boundaries are tool-pairing balanced so a tool-call/result pair is never split.

Every summarization call is bounded to the routed model's context window. For the 1,000,000-token window (deepseek-v4-flash):

- **Output cap** `maxTokens` = `min(window/2, adapter max output)` = `min(500K, 256K)` = **256K**. Reasoning tokens count toward this cap, so the model's thinking shares it with the visible trimmed output — at most ~56K of thinking leaves ≥200K for the output.
- **Per-chunk input budget** = `window/5` = **200K**, so a chunk's input + output (≤256K) stays far inside the window with headroom for estimation error and request overhead.
- **Max chunks** = **10** — the worst-case fragmentation bound over the 1M window: a single very large node (e.g. ~101K, over half the chunk budget) can fill a chunk alone, so 10 chunks cover the full window; the final partial chunk rides on an earlier chunk's headroom rather than adding an extra chunk.

When the trim-able dialogue exceeds one chunk, it is sliced into budget-sized chunks (cut at tool-pairing-balanced boundaries) that are summarized **in parallel** and assembled into one checkpoint under `[part N/M]` dividers. Total input beyond the window (1M) fails loud with a directive to compact first. A transient failure on one chunk (network hiccup, proxy switch, adapter 5xx) retries that chunk up to 2 extra times (3 attempts total) so a single flaky call cannot sink the whole parallel trim; cancellation is never retried. Verified on a real >200K surface: 1,055 nodes / ~403K tokens trimmed as 3 parallel chunks in ~3.7 min, output ~23K tokens (73% reasoning) — comfortably under the shadowed span.

Because the injected nodes sit between the first user message and the rest of the conversation, the trim range starts after them — the opening anchor (first user message) stays outside the range as a structural consequence of that contiguous replacement, not as a protection policy. Everything after the skeleton is trim-able.

Both middle-span replacement and trim are performed through `session.append` with `surfaceOp: { op: 'replace' }`, so the session's own append validation (surface provenance, source-event coverage, tool-result rewrite rules) still enforces integrity at the write boundary.

## Model Experience

### What the model sees (compact-directive)

A directive-driven compaction replaces the middle span with one checkpoint user message. The checkpoint carries the directive in a marker and a guard stating that removed content was removed on purpose and must not be reconstructed. The session head and recent turns are untouched, so the model's next request still contains the task anchor and the latest work.

### What the model sees (trim-directive)

A trim sends the trim-able dialogue to the model with a directive-only prompt; the model's output replaces the whole trim range as one checkpoint carrying a `[Directive trim, per requirement: <requirement>]` marker and a guard stating that removed content was removed on purpose. The injected system nodes and the opening anchor stay outside the range, so the model keeps its environment; everything after them is gone from the model's view. Zero dialogue protection means a broad requirement can strip the session down to just the skeleton and the checkpoint — the model may lose its task anchor, which is exactly what the user asked for.

### Token effect

The directive adds its own tokens to the auxiliary summarization request and to the checkpoint that lands in the conversation. The session head (AGENTS.md + system prompt + skill catalog) is large and preserved verbatim, so compact-directive savings are bounded to the middle span — the same trade the reference design makes. Trim spends one summarization call and unconditionally reduces the trim-able surface.

**Thinking is not disabled, so a custom trim can take tens of seconds to minutes.** The trim call keeps the model's reasoning (deliberately: `reasoningEffort: 'off'` would disable thinking entirely and hurt the cut decisions). On a real run, deepseek-v4-flash spent 34,244 of its 36,874 output tokens on reasoning (~93%) before writing a ~2,630-token trimmed context — the whole operation took ~4.5 minutes for a 28-node, ~9,876-token span. Expect complex natural-language requirements to reason heavily first.

### KV Cache effect

A positional replacement invalidates reuse from the first replaced history token onward, exactly as the upstream compaction backend does. The unchanged head before that range remains reusable.

## Known Limitations and Deferred Work

- **Middle-span savings only (compact-directive).** The fixed head and recent turns are preserved by design, so a session with very little middle content saves little; the tail floor guarantees the last user utterance and its in-flight flow survive regardless. The directive cannot delete protected content — use `/trim-directive` for that.
- **Shrink validation can reject small spans (compact-directive).** A checkpoint must be smaller than the span it replaces; a verbose model summary over a small middle span can exceed it, so the compaction is rejected (recorded in the log, conversation unchanged). This mirrors the upstream convergence check and mainly affects tiny middles — real long sessions compress comfortably.
- **Zero protection is the point (trim-directive), and the risk.** A broad or accidental requirement can delete content the user still needs, down to a session holding only the injected skeleton and the checkpoint. There is no UI undo and no minimum dialogue retention; check the requirement before running it. The trimmed content is NOT erased from the append-only session log (every shadowed node's text survives and the replace records its seqs), but restoring it needs tooling — **fork the session before destructive trims**.
- **Model judgment (trim-directive).** The model decides what survives from the rendered dialogue. It generally follows the requirement, but an ambiguous or self-contradictory requirement may yield an unexpected trim; there is no deterministic per-node guarantee.
- **Tuned for 1M-window models.** The chunking budget (`window/5` input, `min(window/2, 256K)` output, 10 chunks max) is derived from a 1,000,000-token window. On a smaller-window model the absolute numbers shrink proportionally (the budget is always `window/5` etc.), but the adapter output cap of 256K assumes deepseek's limits.
- **Chunking is heuristic-priced (trim-directive).** Chunk boundaries are chosen by the token-meter's per-node heuristic estimates; a misestimate can make a chunk larger than budgeted, though the hard window check still guards the request. Chunking also means a large trim runs several parallel model calls (token cost = the sum of their inputs+outputs, identical to one serial pass).
- **System nodes always preserved.** The injected `agent-instructions` / `system-prompt` / `skill-catalog` nodes are session machinery, never trim-able; the trim range starts after them, so the opening anchor (first user message) stays outside the range too.
- **No before/after rendering.** The transactions record the standard lifecycle (`compaction/start` / `compaction/summary` / `compaction/end`) in the session log; there is no dedicated before/after comparison event, and the conversation UI does not render the directive or its context. A log-visible `compaction/directive-before-after` comparison is deferred.
- **Clean-call summarization (compact-directive).** The summarization request is one focused user message with no system prompt or conversation prefix, so it does not reuse a warm-prefix KV cache. That is the deliberate trade of cache reuse for a more focused summary.
- **Implementation status.** The command, planning, and summarization implementation (P1–P8) is merged, including the AI-driven free-trim command (P6), the compact-directive polish (P7: required directive, shrink validation), and the budgeted chunked trim (P8). The package is not yet published to the npm registry, so installs must come from a local checkout or tarball.
