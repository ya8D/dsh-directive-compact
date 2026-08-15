# TODO

Phased plan for `@ya8d/dsh-directive-compact`. Each phase ships its code and its tests together — tests live with the code they exercise. Mark `[x]` when done and record the step in [`DONE.md`](DONE.md). Push and PR are performed by the maintainer (ya8D); the agent creates branches and commits only.

## P0 — Scaffolding

- [x] New git repository `C:\AI\dsh-directive-compact`, branch `main`
- [x] `package.json` — `@ya8d/dsh-directive-compact`, ESM, bundle (`dsh.bundle`) declaration, minimal peer dependencies, `files` whitelist
- [x] `tsconfig.json` / `tsconfig.test.json` — strict, NodeNext, `verbatimModuleSyntax`
- [x] `vitest.config.ts` / `vitest.e2e.config.ts`
- [x] `LICENSE` (MIT), `.gitignore`
- [x] `src/invariant.ts` — "No runtime invariant" companion with a concrete reason
- [x] `src/index.ts` — function-plugin skeleton (no default export); real command lands in P4
- [x] Repo standards: `AGENTS.md`, `docs/AGENTS.md`, `.agents/notes/README.md`
- [x] Agent Note: two-path directive compaction with a fixed-skeleton head (`implemented/architecture/2026-08-15-two-path-directive-compaction.md`)
- [x] `README.md` — contract, install, command, Model Experience, Known Limitations
- [x] `docs/TODO.md` / `docs/DONE.md` — this workflow log

## P1 — Planning (range selection)

- [x] `src/plan.ts` — `skeletonEndIndex` (leading skeleton = compact checkpoint + injected nodes before the first user), `planCompaction` (anchored on surface user utterances; keep head `keepHeadUsers` + tail `keepTailUsers` user turns verbatim, summarize the middle; defaults 3/3 via `PlanConfig`)
- [x] Unit tests: head boundary (fresh, compacted, empty), user-anchor splitting, middle selection, tail floor (last-user and in-flight flow preserved), configurable budgets, repeated-compaction (compact checkpoint absorbed into the skeleton)
- [x] Real-session verification: ran `planCompaction` over a twice-compacted session (101 log turn markers, 57 live surface user anchors) — head/middle/tail split correct, last user in tail; verified surface anchors, not turn markers, stay correct across compaction
- [x] Typecheck + build green (22 tests pass)

## P2 — Summarization

- [x] `src/summarizer.ts` — `FOUR_POINT_INSTRUCTION` (task goal / done steps / findings / next step + verbatim `[user]` utterances, ContextForge `_SUMMARY_PROMPT`; the `[user]` marker is a named contract shared with `renderSpan`), `buildSummaryPrompt` (directive layered over the four-point baseline), `renderSpan` (role-prefixed plain text), `summarizeWithDirective` (clean single-message call: BlockAssembler, image rejection, no-text rejection, finish-error mapping, oversized-input guard), `checkpointMarker` / `CHECKPOINT_GUARD`. The ContextForge `_build_directive_only_prompt` port (`directiveInstruction`) was dropped — P1 established the single-path design, so it had no caller.
- [x] Unit tests: prompt construction (with/without directive), renderSpan (text/tool blocks), summary marker/guard, image rejection, no-text rejection, finish-error mapping (max-tokens / error), oversized-input guard
- [x] Typecheck + build green (32 tests total: 19 plan + 13 summarizer)

## P3 — Command transaction + plugin entry

- [x] `src/command.ts` — `surfaceNodes` (surface → node descriptors), `resolveDirectiveTarget` (configured / routed / agent-options fallback), `executeDirectiveCompact` (plan → summarize middle → `session.append` replace with checkpoint source + `compaction/start`/`summary`/`end` lifecycle; failed attempts close the lifecycle with the error)
- [x] `src/index.ts` — function plugin (`name`/`inject`/`apply`, no default export), `Config` schema (keepHeadUsers/keepTailUsers/summarization pair/maxTokens), registers `/compact-directive` via `ctx.effect` with handler drain
- [x] Unit tests (`tests/command.spec.ts`): surfaceNodes source kinds, resolveDirectiveTarget fallbacks, executeDirectiveCompact (none for short session / middle compaction + lifecycle event sequence + checkpoint source / error closes lifecycle)
- [x] REAL-composition test (`tests/loader-composition.spec.ts`): Loader boots cordis.yml with the plugin, `/compact-directive` registered; `expect('default' in mod).toBe(false)`; HMR-safety (dispose fiber → command unregistered)
- [x] Typecheck + build green (41 tests total)

## P4 — Regression / polish

- [x] Regression test: a cancelled/failed directive compaction leaves the surface intact (lifecycle closed, no partial replace)
- [x] `cordis.patch.yml` — insert-only bundle row (pure increment; `--dump-config` verification lands in P5)

## P5 — Bundle + verification

- [x] `--dump-config` verification of the inserted bundle row
- [x] With-key e2e: real DeepSeek model, self-skips without a key

## P5.5 — Documentation

- [x] README final pass against shipped behavior (single-path design, bundle install verified, implementation status)
- [x] Known Limitations current (no before/after rendering, middle-span savings only, clean-call summarization, implementation status)
- [x] This TODO fully checked off, DONE current

## P6 — `/trim-directive` (AI natural-language trim, zero protection)

> **Superseded by P10 (full-freedom range).** The system-node exclusion described below was removed in P10: the trim range is now the ENTIRE surface, and the injected skeleton is trim-able (it regenerates per request). See the P10 section for the current design.

User verdict after real-session review: the fixed head makes `/compact-directive` unable to honor "delete all context about X" when X lives in the head — head protection outranks the directive. The free-trim command hands the ENTIRE conversational surface to the model and lets the user's natural-language requirement decide what survives. Design confirmed with the user (English prompt template; shrink validation retained; injected system nodes are NOT trim-able content).

Design (from source analysis + user confirmation):

- **AI-driven, not keyword-driven**: the whole conversational surface (user utterances, assistant replies, tool results — but NOT the injected system nodes) is rendered and sent to the LLM with a directive-only prompt (ContextForge `compact_by_directive` shape: no four-point baseline, the requirement is the sole instruction). The model outputs the trimmed context, which replaces the whole trim range as one checkpoint.
- **System nodes are excluded, not trimmed**: `agent-instructions` / `system-prompt` / `skill-catalog` injections are session machinery, not dialogue — deleting them breaks the model's environment and they are not re-injected after a replacement. Three guards: (1) render exclusion (skip `source.kind === 'plugin'` nodes when building the LLM text); (2) range exclusion (replace starts at the first trim-able node, system nodes stay outside the range); (3) session append validation as backstop (uncovered system nodes in a range → `must include every shadowed surface node` fail-loud).
- **Lifecycle**: this is a summarization transaction (LLM call), so it uses `compaction/start` / `compaction/summary` / `compaction/end` with `turn: null` standalone, checkpoint source via `compactCheckpointSource` — not the model-free `compaction/prune` shape (that was the earlier keyword design).
- **Shrink validation**: the framed checkpoint must be smaller than the shadowed span (mirror of upstream convergence check); fail with a `summary`-class error otherwise.
- **Balanced cuts**: the trim range's boundaries must satisfy `toolPairingBalancedBefore/After` so a tool-call/result pair is never split.

- [x] Rewrite Agent Note `implemented/architecture/2026-08-15-trim-directive.md` — AI trim shape, system-node exclusion contract, shrink validation
- [x] `src/trim.ts` — `TRIM_INSTRUCTION` + `buildTrimPrompt(directive)` (directive-only, English, no four-point baseline) + `trimMarker`
- [x] `src/summarizer.ts` — `summarizeWithDirective` gains optional `promptBuilder` and `markerBuilder` parameters (trim passes `buildTrimPrompt` + `trimMarker`); all safety logic reused
- [x] `src/command-trim.ts` — rewrite `executeTrim`: empty input errors; busy refusal; trim range = after the last injected system node (contiguous-replace structural consequence), balanced boundaries; `compaction/start` (turn null) → render → LLM call → shrink check → `compaction/summary` → `user/message` replace (sourceEventSeqs covers all shadowed + start/summary) → `compaction/end`; failure closes the lifecycle
- [x] `src/index.ts` — trim command description: "trim the whole conversation per a natural-language requirement"
- [x] Unit tests (`tests/trim.spec.ts`, 13): whole-range replacement, lifecycle sequence, checkpoint source, system nodes preserved (render + range), directive verbatim in prompt, shrink rejection, empty input, busy refusal, failure closes lifecycle, cancelled leaves surface intact
- [x] REAL-composition test: Loader boots with `/trim-directive` registered; HMR-safety dispose unregisters both commands
- [x] README: both commands, Model Experience, Known Limitations (AI judgment, system nodes always preserved, zero-protection risk)
- [x] Typecheck + build green (55 tests: plan 16 + summarizer 13 + command 10 + trim 13 + loader-composition 3)

## P7 — `/compact-directive` polish (directive-led middle summarization)

- [x] Require the directive: empty `rawInput` returns an error directing the user to `/compact` (mirror of upstream's "no arguments" contract; no silent degradation to the weaker plain summary)
- [x] Add shrink validation: the framed checkpoint must be smaller than the shadowed span (mirror of upstream's convergence check); fail with a `summary`-class error otherwise
- [x] Confirm the middle-compaction differentiation stays (directive layering + head/tail protection are the value; upstream wins on KV cache and 8-section structure, so the no-directive path must not compete)
- [x] With-key e2e: real-model run may legitimately hit the shrink rejection (a verbose model summary can exceed a small span) — the e2e asserts both correct outcomes (success + lifecycle, or shrink rejection + lifecycle closed + surface unchanged); unit tests cover the deterministic shrink-rejection and empty-directive cases

## P8 — `/trim-directive` budgeted chunked compression (v2 design)

User-confirmed v2 design for large conversations: bound every summarization call inside the model's context window instead of failing on a too-large render or a truncated summary.

- **Window W**: `ctx.llm.resolveModelInfo(...).context.contextWindow` — MAXIMUM COMBINED request + response tokens (dsh `LlmModelContext.contextWindow` JSDoc). deepseek-v4-flash: 1,000,000 (decimal, DeepSeek's spec — not 2²⁰).
- **Output budget maxTokens** = `min(W/2, adapter DEFAULT_MAX_TOKENS)` = `min(500K, 256K)` = 256K. Reasoning tokens COUNT toward the output budget (`completion_tokens_details.reasoning_tokens`), so thinking eats into the 256K — the model's own trade, not a configured split; at most ~56K of thinking leaves ≥200K of output, matching the chunk input.
- **Per-chunk input budget** = `W/5` = 200K. Single chunk occupies 200K in + ≤256K out = ≤456K < W (544K headroom for token-meter estimation error + request overhead).
- **Chunk count** = `ceil(totalInput / 200K)`, capped at 10; total input > chunks × budget → fail loud ("compact the session first"). 10 = worst-case fragmentation bound over the real 1M window (single ~101K node per chunk → `ceil(1M / 101K) = 10`); the final partial chunk rides on an earlier chunk's headroom, never adding an extra chunk.
- **Chunk unit**: `ctx.tokenMeter.measure(session).nodes[].tokens` (same source as upstream `selectCompactableRange`); cut points expand to `toolPairingBalancedBefore` so a tool-call/result pair is never split.
- **Execution**: chunks summarized in parallel (no artificial concurrency cap; HTTP 429 handled by the adapter's retryPolicy).
- **Assembly**: one `user/message` replace over the whole trim range; marker + guard once; each chunk's output appended as its own text block with `[part N/M]`.

- [x] Verify feasibility against dsh source (token-meter measure, resolveModelInfo, adapter max-tokens, parallel stream, multi-block replace) and record in the Agent Note
- [x] `src/trim.ts` — budget math (`resolveTrimBudget`, `chunkTrimNodes` with balanced cut points)
- [x] `src/command-trim.ts` — parallel chunked summarization + `[part N/M]` assembly into one replace
- [x] Unit tests: budget math, chunk boundary balancing, parallel dispatch, part assembly, fail-loud on total input > window
- [x] With-key e2e for `/trim-directive` (real DeepSeek call, self-skips without a key)
- [x] README: chunking behavior, Model Experience, Known Limitations
- [x] Typecheck + build green

## P9 — Per-chunk retry for `/trim-directive` parallel chunks

Motivation (user-verified on "插件并发测试1"): the first parallel trim failed with `produced no text summary content` during a network/proxy switch — a single flaky chunk call sank the whole trim. The data layer's failure atomicity was correct (lifecycle closed, surface unchanged), but a transient hiccup should not require a full re-run of a multi-minute operation.

- [x] `summarizeChunkWithRetry` — each chunk gets up to 3 attempts (1 initial + 2 retries) for transient failures (network hiccup, proxy switch, adapter 5xx); cancellation/abort and `DirectiveCompactionError` (expected failures) are never retried
- [x] Unit tests (+2): transient failure retries and succeeds (2 stream calls, lifecycle complete); persistent failure gives up after 3 attempts with the lifecycle closed and surface unchanged
- [x] README: parallel-trim retry behavior + real 403K/3-chunk verification data; DONE records the "插件并发测试1" case (1,055 nodes / 402,837 tokens → 3 chunks, output 23K with 73% reasoning, shrink passed)
- [x] Typecheck + build green (71 unit tests: plan 16 + summarizer 13 + command 12 + trim 27 + loader-composition 3; + 3 e2e)

## P10 — `/trim-directive` full-freedom range (no system-node protection)

Motivation (user-verified on "精确删除测试2"): the trim start ("after the last injected system node") misfired on forked/compacted sessions. A real session shows the structure `compact checkpoint[0] → dialogue → injected skeleton[5-7] → dialogue…`: automatic compaction folds the original skeleton into a checkpoint (upstream `selectCompactableRange` starts at `surfaceNodes[0]`), and agent-instructions/system-prompt/skill-catalog are re-injected on every step (source-verified: agent-loop `preStep` calls `systemPrompt.assemble()` + `agent-instructions` composes into `agent/pre-step` messages — both per-request, not surface-persistent). So the "protect injected nodes" rule both mis-located the trim start AND protected nodes that regenerate anyway.

Decision (user-confirmed): **trim the WHOLE surface, no system-node protection.**

- Trim range = `surface[0]..surface[last]` (everything; only tool-pairing-balanced boundaries remain, as a session-integrity constraint).
- Deleting the injected skeleton is safe: agent-instructions / system-prompt / skill-catalog are re-injected on the next request by the agent loop (verified in agent-loop `preStep` and agent-instructions `agent/pre-step`), so the model keeps its environment without manual re-injection.
- A compact checkpoint in the range is also trimmed (its content lives in the append-only log; recoverable by tooling).

- [x] `src/command-trim.ts` — `selectTrimRange` returns the full surface; delete `isInjectedSystemNode`
- [x] Update tests: full-range trim now includes the injected skeleton (no more "system nodes preserved" assertions); adjust `trim.spec.ts` (system-node preservation, whole-surface, prompts)
- [x] Update Agent Note `2026-08-15-trim-directive.md` (full freedom, per-request re-injection) + README Known Limitations
- [x] With-key e2e: trim on a real session now may remove the skeleton (verify next request still works)
- [x] Typecheck + build green (69 unit tests: plan 16 + summarizer 13 + command 12 + trim 25 + loader-composition 3; + 3 e2e)

## P10.1 — Fixed 50K chunk budget (trim latency)

> Supersedes the window-derived chunk numbers in P8 (`W/5 = 200K`, `maxChunks = 10`): the plugin targets the 1M-window DeepSeek models, so the chunk size is now fixed rather than derived.

Motivation (user-verified on "复杂对话 (1)", `session-43a12820`): `/trim-directive 删除telemetry相关的内容` on a 199-node / ~178K-token surface opened `compaction/start` and produced no summary/end for 10+ minutes — a single ~178K-token call (< the 200K budget) that hung. 50K chunks split that session into 4 parallel calls, each ~4× smaller and independently retriable.

Decision (user-confirmed): **hardcode per-chunk input = 50K heuristic tokens, max chunks = 20, full parallel (no artificial concurrency cap).**

- `resolveTrimBudget` — `chunkInputBudget = 50_000`, `maxChunks = 20` (20 × 50K = 1M = the full window); `maxTokens` stays `min(window/2, adapter)`.
- Harness feasibility verified: no llm-layer concurrency limiter (20 parallel `ctx.llm.stream()` calls run directly; 429s handled by the adapter's retryPolicy + the per-chunk 3-attempt retry); 50K heuristic tokens ≈ 200K rendered chars ≈ ≤150K real tokens even on Chinese-heavy text (meter prices 4 chars/token, which undercounts CJK) — per-call input + 256K output ≤ 1M window; render well under the summarizer's 4M-char guard.
- `chunkTrimNodes` cut semantics unchanged (accumulate to the budget, roll back to the balanced boundary) — "首次超过 50K 就分片" is the existing first-fit behavior with the new constant.

- [x] `src/trim.ts` — fixed `TRIM_CHUNK_INPUT_BUDGET = 50_000` / `TRIM_MAX_CHUNKS = 20`; JSDoc rewritten (fixed vs derived rationale)
- [x] `src/command-trim.ts` — comments updated (50K / 20 chunks / full parallel); no code change (existing `Promise.all` is already full-parallel)
- [x] Unit tests: budget assertions 50K/20; chunk tests resized (20K nodes for multi-chunk, 15K for the balanced roll-back, 60K oversized node) to keep the same chunk geometry under the 50K budget
- [x] README Known Limitations (50K / 20 chunks) + time warning (large sessions are several parallel 50K chunks)
- [x] Agent Note `2026-08-15-chunked-trim-budget.md` revised (fixed 50K/20, hang motivation, feasibility re-verified)
- [x] Typecheck + build green

## P10.2 — Phase logging (where does the time go)

User request: log each phase of a trim/compaction so a stalled or slow run can be diagnosed ("哪里卡住了，哪里耗时"), following upstream conventions.

- Conventions verified in harness source: `ctx.logger(name)` named facade (Cordis), `info/warn/debug` + `%s/%d` placeholders, default console threshold INFO (LoggerLevel ERROR=0/INFO=1/WARN=2/DEBUG=3), logger-console `levels: { name: number }` per-scope override; upstream `compaction-basic` reports results via `ctx.logger.info` and failures via `warn`.
- `src/log.ts` — `shortDirective` (120-char cap so a huge requirement cannot flood a line).
- `src/command.ts` — compact: `begin` (directive, surface, plan), `summarization done in Nms`, `committed` (nodes/tokens → checkpoint tokens, total ms); `warn` on failure with reason + elapsed; `debug` on refusals.
- `src/command-trim.ts` — trim: `begin` (directive, surface, budget), `priced … → N chunk(s)`, per-chunk `done in Nms (output tokens)`, `all N chunks done in Nms`, `committed` (trimmed → checkpoint, total ms); `warn` on failure and on each per-chunk retry; `debug` for chunk seq/token geometry and refusals.
- `src/summarizer.ts` — `debug`: time-to-first-chunk and total stream time (locates network/provider latency vs generation time).
- Tests: `tests/helpers.ts` `createLoggerStub` (callable + method-bearing, records raw printf args); +3 log-assertion tests (trim milestones, compact milestones, compact failure warn). Suite 72 unit.
- README `Observability` section (what each line means; how to raise the scope to debug via logger-console `levels`); CHANGELOG entry; DONE updated.
- Real-render verification of every log line through Cordis `Logger.format` (placeholders align, CJK directive renders).
- Typecheck + build green (72 unit + 3 e2e).

## P10.3 — No-change is a success, not a failure (the "telemetry not found" hang)

User hypothesis (confirmed against code): the "复杂对话 (1)" hang — `删除telemetry相关的内容` on a session with no telemetry — was the model returning the context essentially verbatim. Under the old single-200K-chunk path the near-verbatim rewrite could hit `MAX_TOKENS` (thinking + ~178K output > 256K cap), which is a plain `LlmError` that the per-chunk retry loop retries 3 times — each attempt several minutes, total 10-20 min with no session events. Even without truncation, the assembled checkpoint is not smaller than the shadowed span and shrink validation threw a `summary` error. User decision: an unshrunk output is OK; report it, don't retry or fail.

- Verified against dsh source: `compaction/invariant.ts` requires every success `compaction/end` (no `error`) to have a `compaction/summary`, but does NOT require a surface replace — so a no-change lifecycle `start → summary → end` (no `user/message` replace) is valid.
- `src/command-trim.ts` — shrink check moved after `compaction/summary` append; when `checkpoint >= shadowed`, append `compaction/end` (no error), log `no change` at info, return success `Nothing to trim: the model found no content worth removing (~N tokens unchanged).` Surface untouched; no retry loop can start.
- `src/command.ts` — same for `/compact-directive` (`Nothing to compact: …`).
- Unit tests: shrink tests rewritten from "rejects with DirectiveCompactionError + [start, end] lifecycle" to "no-change success + [start, summary, end] lifecycle + no replace + end has no error" (both commands).
- e2e: the shrink-rejected branch became a no-change success branch (both outcomes asserted); fixture now appends `step/start`/`step/end` (the real token meter requires a matching step for `assistant/message` — the old catch branch had been silently absorbing this); the trim directive targets real `git workflow detail` content in the fixture so the real model reliably shrinks (the old `drop all dialogue, keep nothing` could return reasoning-only and fail with `produced no text summary content`).
- README "When there is nothing to remove" section; CHANGELOG entry; DONE updated.
- Typecheck + build green (72 unit + 3 e2e, real key).

## P11 — Deferred / optional

- [ ] Trim latency: a large-surface trim can take many minutes (partially mitigated by P10.1 — the hung "复杂对话 (1)" case was a single ~178K-token call that now splits into 4 parallel 50K chunks). Remaining options: (a) progress feedback (e.g. "compressing chunk N/M" or elapsed time in the result); (b) cap the rendered input (pre-summarize or require a prior compaction); (c) surface a timeout/abort affordance. Documented in README Known Limitations.
- [ ] UI rendering of the `compaction/directive-before-after` comparison (upstream conversation UI change; requires a harness PR with its own Agent Note)
- [ ] With-key e2e: safety-refusal probe for aggressively negative directives on DeepSeek
- [ ] BUG (user-verified, GUI): the trimmed/compacted conversation never disappears from the UI dialogue — both during "executing…" and AFTER the command completes. Root cause (source-verified): this is dsh's deliberate transcript design, NOT a plugin bug. The UI conversation flow renders only append-origin events (`surfaceOp === 'append'`; `isAppendSurfaceEvent`), while a trim/compaction lands a `surfaceOp: { op: 'replace' }` checkpoint — "replacement copies stay model-only" (dsh `surface.ts`). So the model sees the checkpoint but the user keeps seeing the original dialogue; upstream `/compact` behaves identically (it shows a `manual-compaction` card only for the exact command name `compact`, which our commands do not match). The data layer is correct (checkpoint lands on the surface; verified on real sessions). Fixing the UI requires an upstream `ui-conversation` change to render a replacement/compaction card for non-`compact` command names — outside this plugin; the plugin-side fallback is documentation. Options: (a) upstream UI change (high effort, harness PR + Agent Note); (b) document that the original dialogue stays visible by design and the effect is visible in the session trace (current recommendation); (c) have the plugin name its command to trigger the existing `manual-compaction` card (pollutes upstream semantics, violates pure-increment).
