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

## P11 — Operation-mode trim (operation manifest: the model decides, the plugin executes)

Motivation (user-confirmed, deep-dived): the rewrite mode's root problem is "output ≈ input". Real anchor "复杂对话3": 9 chunks / 362,509 ms / ~560K output tokens — every chunk that changes ANYTHING must decode ALL of its kept content (parallel, so wall time = slowest chunk ≈ 6 min), and kept content passes through the model's hands (verbatim rule protects only `[user]`; assistant/tool content can drift or lose facts). The `<<NO_CHANGE>>` status value (implemented, merged via PR #14) only covers the all-or-nothing edge — it does not speed up the "delete a little from a big surface" case. Operation mode makes the model a DECISION-MAKER instead of a content PRODUCER: it outputs a small operation manifest (delete / summarize), the plugin executes it programmatically — kept nodes are spliced verbatim (zero generation, 100% fidelity), only summary text is model-generated.

### Design (deep-dive conclusion)

- **Input format (numbered rendering, renderSpan variant)**: numbering = **global event seq** (reuses the harness's native seq system — session events carry seq and surface nodes are a seq list; `tool-session-query` already references events as `seq N`, and a real user instruction used "delete seq 1344493 …"; no surface-node ordinal/numbered rendering exists to reuse, so seq is reused instead of inventing per-chunk ordinals). Node start line = `[seq <global seq>] ` + the existing role prefix (`[user]` / `[assistant]` / `[tool] called tool …` / `[tool] tool result:`); **in-node continuation blocks indent 2 spaces** (`  [role] …`) — a numbered line is a node boundary, an indent is inside the node. Numbering exists only on the input side; checkpoint assembly uses the unnumbered originals. seq is naturally unique across chunks → **zero mapping** (validation = "does this chunk's node list contain this seq"); block-level numbering stays Future.
- **Output format (strict manifest template, one operation per line + content blocks)**:
  - `delete: 28039, 28045` — whole-node deletion (comma list + `28040-28045` ranges; seq digits copied from the rendered `[seq N]`, zero generation)
  - `rewrite: 28039` + `---content---` … `---end---` content block — **partial in-node edits** (content = the node's full replacement text, plain content without numbering/role prefix; the plugin re-adds the `[role] ` prefix from the original node, matching the untouched-node format. **Missing or empty content block → validation failure, fall back**)
  - `summarize: 28040-28045` + `---content---` … `---end---` content block (plain summary text, inserted in place of the whole range)
  - No operation: exactly one line `<<NO_CHANGE>>` (or empty output = no-change)
  - Rules: operation lines start at column 0; content inside a block is verbatim (empty lines included) but must not contain a `---end---` line
- **Distribution impact of in-node partial deletion (honest correction)**: telemetry-like mentions **concentrated** in few nodes → only those nodes rewrite, the rest splice verbatim (near-zero generation); **scattered** across many nodes → per-node rewrites = most nodes rewritten (limited speedup — a scattered deletion semantically needs wide-area edits; no free lunch). Speedup depends on mention concentration, anchored by real measurements.
- **Parsing + validation (correctness first)**: malformed format / prose output → **fall back to rewrite mode** (the existing TRIM_INSTRUCTION path, re-called once; the code exists); out-of-range seq / delete overlapping summarize or rewrite / missing or empty content block / a split tool-call-result pair (deleting one side must include the other; rewrite tool-call without its result → fall back) / unknown operation line / unpaired `---content---`/`---end---` → fall back; empty manifest → no-change. **Any uncertainty falls back; never half-execute.**
- **Execution (checkpoint assembly)**: per chunk = untouched-node originals (renderSpan form, matching the rewrite-mode output form) spliced + rewrite nodes replaced by model content (plugin adds the role prefix) + summarize ranges replaced by the summary + delete nodes skipped; multi-chunk `[part N/M]`; checkpoint = marker + guard + parts; shrink validation, lifecycle, and tool-pair balance unchanged.
- **No whole-chunk summarization**: summarize ranges must be explicitly named by the model; nodes outside any range splice verbatim, not a character changed (else trim silently becomes compact). A mixed instruction like "delete telemetry + compress the login flow into bullet points" is expressed in one pass.
- **Two-mode dispatch (v1 simplification)**: the operation-mode prompt asks for the manifest only; parse failure falls back to rewrite mode (one re-call). Model-declared mode / single-call dual-format dispatch stays an enhancement.
- **Enhancement candidates (Future)**: `delete-text: 28039, "exact string"` — the model cites a verbatim fragment, the plugin does string-match deletion (zero generation, zero drift); a mismatched fragment falls back to rewrite. v1 uses rewrite (more robust); delete-text is the enhancement.

### Expected gains (estimate, awaiting measurement)

- Output 560K → ~125K tokens (manifest + small summaries + unavoidable reasoning ~12.7K/chunk) → 362s → 90-150s (3-4×)
- **Fidelity (essential improvement)**: kept nodes zero-generation → 100% original, no drift, no hallucination; trim changes from "model rewrites" to "model decides + plugin executes"
- Auditable: deletion decisions are explicit and verifiable; the model under-deletes → keeps more → shrink fails → no-change message (visible error, not silent)

### Risks and boundaries (honest)

- Model adherence to the manifest format is the biggest uncertainty; non-adherence → fall back (correct but no speedup)
- Reasoning cannot be removed → the speedup has a floor ("within 1 minute" is unattainable without cutting thinking = quality trade)
- "Batch rewrite"-style requirements (all 50 changed) bloat the manifest → boundary degradation; the model then outputs full text on the rewrite path
- v1 fidelity uses rendered text; raw ContentBlock copies (tool-result structure) need user-message pairing validation → Future enhancement
- Numbered-reference accuracy (model cites a wrong seq) → out-of-range validation falls back; under-deletion → shrink backstop

### Work items

- [x] Numbered rendering (renderSpan variant `renderSpanNumbered`, `[seq N]` global-seq reuse) + operation-mode prompt (`buildOpModePrompt`, delete/rewrite/summarize + `---content---`/`---end---` blocks + `<<NO_CHANGE>>`)
- [x] Manifest parser (`parseOpManifest`: delete lists/ranges, rewrite/summarize content blocks, no-change; prose/unknown lines/indented lines/missing blocks/unpaired delimiters/marker-mixing all rejected)
- [x] Validator (`validateOpManifest`: out-of-range / overlap / summarize boundary missing or inverted / operation-range tool-pair boundary balance — a tool pair is either wholly inside or wholly outside every operation range) → fall back to rewrite mode
- [x] Executor (`executeOpManifest`: untouched nodes spliced verbatim + rewrite replacement (plugin adds the role prefix) + summarize replacement + delete skip)
- [x] Integration: `summarizeChunkWithRetry` gains promptBuilder/markerBuilder/renderer parameters; each chunk runs operation mode first, parse/validation failure falls back to rewrite mode (usage merged across both calls); `summarizeWithDirective` gains a renderer parameter
- [x] Unit tests (op-mode.spec.ts 22: rendering/prompt/parse/validation/execution; trim.spec.ts +2 command-level delete/rewrite end-to-end + existing assertions adapted to the dual call)
- [x] **Real-session verification ("复杂对话4" `session-ebd5011a`, failure exposed)**: 199 nodes / 366,720 tokens / 9 chunks, `删除telemetry相关的内容` → **830,451 ms (13.8 min)**, 2.3× slower than the rewrite baseline (362s). rawOutput blocks = 18 = **9 chunks × 2 calls per chunk**: the model **emitted prose on 9/9 chunks** (did not follow the manifest); each op-prose rewrite + fallback rewrite call → double cost. telemetry 127→0 ✓, lifecycle complete ✓ (functionally correct, performance unacceptable)
- [x] **Fix (plan B, measurement-driven)**: `buildOpModePrompt` now offers **dual formats** (FORM 1 manifest, preferred; FORM 2 full rewrite legalized — model prose is now a legitimate choice, quality on par with rewrite mode); `command-trim.ts` dispatch: **prose (parse invalid) → reuse the op output directly as the rewrite result (1 call, warn log)**; **manifest parses but validation fails (out-of-range seq etc., rare) → one rewrite-mode re-call** (the op output is a manifest and unusable as content). Worst case = rewrite baseline 1 call
- [x] **Regression tests (user asked "why was this not caught")**: added `P11 regression: reuses prose op-mode output with ONE call per chunk` (asserts 1 call + prose lands) and `parseable but invalid manifest falls back to ONE rewrite call` (asserts 2 calls + fallback output); existing prose-path assertions updated from dual to single call (3→2, 10→5, 9→5); prompt tests add FORM 2 assertions. 100 unit + 3 e2e
- [x] **Pairing fix (TDD: tests first, 105 green)** — real log (web-20260816-144813.log) showed 3 chunks falling back (147-355s) on `operations starting at seq X split a tool call/result pair`: the model's operation ranges started at the result while the call stayed outside (the model does not know tool-pair constraints). Layered fix (user confirmed "90%+ of fallbacks avoided"):
  - **rewrite exemption**: rewrite is a content-level edit (node kept, structure unchanged) — only rewrite of a tool-call node is rejected (its result would dangle); rewrite of a tool-result/text node is allowed directly. "Delete a bit of telemetry inside a result" = rewrite one node, never a whole-node/paired deletion
  - **delete/summarize pairing extension**: one-sided reference (call only or result only) → the paired node is auto-included by callId (only when in the same chunk; cross-chunk rejects) → zero extra LLM calls. Deleting a result auto-deletes its call (the whole tool record)
  - **parseOpManifest backtick marker**: `` `<<NO_CHANGE>>` `` recognized as no-change (consistent with isNoChangeMarker; fixes chunk 5 false positive)
  - validateOpManifest new signature `{kind:'ok', manifest} | {kind:'invalid', reason}` (returns the extended manifest)
  - New tests: backtick marker; rewrite-result exemption; rewrite-call rejection; delete one-sided extension (both directions); summarize one-sided extension; command-level rewrite-result 1 call / delete one-sided 1 call
- [x] Agent Note (`2026-08-16-operation-mode-trim.md`): add the real-run measurement, plan B, and the pairing fix (landed in P13)

## P12 — Trim time optimization (delete-text + inflation guard)

Motivation (analysis of `web-20260816-153424.log` + "复杂对话8" `session-8e7a1427`): with 9/9 chunks at zero fallback, the **model over-uses rewrite** (partial deletion = outputs the whole node content) → slowest chunk 556s, checkpoint inflated +4,049 → overall no-change (telemetry not deleted). Accounting confirmed: structural overhead is only ~155 tokens (not the cause); **chunk 5's rewrite net inflation +6,432** (the model "claims full content minus X" but outputs more) ate the other 8 chunks' shrinkage.

- [x] **Rewrite inflation guard** (user spec: output > original × 1.1 → keep the original conservatively): `REWRITE_INFLATION_RATIO = 1.1` (chars comparison, applied before the extension logic so structural pairing stays consistent) — inflated rewrites are dropped from the manifest, the node keeps its original text
- [x] **`delete-text` operation** (root fix for "partial deletion → big rewrite output"): `delete-text: <seq>, "<exact fragment>"` → the plugin deletes the fragment by exact string match (zero generation, zero inflation); a fragment absent from the node's rendering → the operation is conservatively dropped (node keeps original); out-of-range seq / overlap with other operations → reject
- [x] **Prompt guidance**: delete-text syntax + "rewrite content must stay close to the original (a rewrite larger than the original is discarded)" + the existing prefer-delete / result-node guidance
- [x] Tests (TDD): inflation removal/retention, delete-text parsing (valid/malformed), fragment match/mismatch, out-of-range/overlap, execution deletion + command-level 1 call. 118 unit + 3 e2e
- [x] **Round-2 real-run defect fixes (`web-20260816-160515.log`, TDD)**:
  - **delete-text parse tolerance**: the model emitted `delete-text: 639, "pkg[\"session-telemetry` (a code fragment with quotes, `\"` escapes, unclosed quote) → the old regex failed → the whole output reused as prose (14K/22K tokens). Fix: strip surrounding quotes + restore `\"`/`\\`; a bare fragment (no quotes) takes the rest of the line; an empty fragment rejects
  - **overlap dedup + conservative merge**: the model repeated operation lines (`rewrite: 7369` ×3) → the old logic rejected even same-operation duplicates → fallback 406s/432s. Fix: dedup within the same operation (idempotent); cross-operation overlap merges by "keep more content wins" (delete-text > rewrite > delete); a summarize range overlapping a single-node operation still rejects
  - **structural-extension vs delete-extension mutual exclusion fix**: delete extension only walks the model's explicit deletes (a result added by structural extension paired with its rewritten call is a legal combination, not re-checked)
  - **fragment-mismatch logging**: prints the fragment (first 120 chars)
  - Tests +4 (escaped/unclosed/bare-fragment parsing, same-op dedup, cross-op merge). 123 unit + 3 e2e
- [x] **Review confirmation (user)**: deletion-priority chain order correct with no dangling references; a result structurally extended and also referenced by delete-text → delete wins at execution, delete-text idempotently ignored (model-contradictory instruction; structural deletion is the conservative choice; acceptable); residual risk: a cross-line quoted fragment → `(.*)` single-line regex unrecognized → prose pollution (much smaller than before the fix; the "single-line fragment" prompt guidance mitigates; non-blocking)
- [x] **Round-3 real-run fixes (`web-20260816-163134.log`, TDD)**: 222s (556s → 3.7 min) ✓ shrink success (366,793→365,779) ✓ 9/9 zero fallback ✓ 6 delete-text executions ✓, but 3 fragment mismatches — root causes (decode-confirmed):
  - **double backslashes** (chunk 1 seq 635): tool output renders Windows paths as literal `\\` (`docs\\subsystems\\...`), the model copied them, but the parse restored `\\`→`\` and broke the match → **drop the `\\` restore (only `\"` is restored)**
  - **leading indentation** (chunk 2 seq 850 etc.): the model copied continuation lines from the numbered rendering (`  53: | ...` leading two spaces), the renderSpan baseline has no indent → **`normalizeFragment` strips leading whitespace before matching/deleting**
  - Tests +2 (`\\` literal retention, leading-indent match). 125 unit + 3 e2e
- [ ] Real-session verification: delete-text hit rate (does the model use the new syntax) + does the inflation guard eliminate no-change + total wall time

## Future — Deferred / optional (no P number yet; promote to P## when implemented)

- [x] Trim speedup (core): the `<<NO_CHANGE>>` status value is implemented (PR #14) — it solves only the "nothing to remove" edge, **not** the "delete a little" case (P11 owns that). Remaining: real-session verification, model-misjudgment wording calibration.
- [ ] **Conservative shrink-failure path (P12 follow-up)**: on no-change, consider executing only delete/summarize/delete-text with inflated rewrites kept verbatim instead of giving up wholesale (the inflation guard already drops inflated rewrites individually, but an overall shrink failure still reports no-change)
- [ ] Trim latency remaining items: progress feedback ("compressing chunk N/M" / elapsed), cap the rendered input (compact before trim), timeout/abort affordance. README Known Limitations documents the time cost.
- [ ] UI rendering of the `compaction/directive-before-after` comparison (upstream conversation UI change; requires a harness PR with its own Agent Note)
- [ ] With-key e2e: safety-refusal probe for aggressively negative directives on DeepSeek
- [ ] BUG (user-verified, GUI): the trimmed/compacted conversation never disappears from the UI dialogue — both during "executing…" and AFTER the command completes. Root cause (source-verified): this is dsh's deliberate transcript design, NOT a plugin bug. The UI conversation flow renders only append-origin events (`surfaceOp === 'append'`; `isAppendSurfaceEvent`), while a trim/compaction lands a `surfaceOp: { op: 'replace' }` checkpoint — "replacement copies stay model-only" (dsh `surface.ts`). So the model sees the checkpoint but the user keeps seeing the original dialogue; upstream `/compact` behaves identically (it shows a `manual-compaction` card only for the exact command name `compact`, which our commands do not match). The data layer is correct (checkpoint lands on the surface; verified on real sessions). Fixing the UI requires an upstream `ui-conversation` change to render a replacement/compaction card for non-`compact` command names — outside this plugin; the plugin-side fallback is documentation. Options: (a) upstream UI change (high effort, harness PR + Agent Note); (b) document that the original dialogue stays visible by design and the effect is visible in the session trace (current recommendation); (c) have the plugin name its command to trigger the existing `manual-compaction` card (pollutes upstream semantics, violates pure-increment).

## P13 — Standardization (harness conventions, release readiness)

Align the package with DeepSeek Harness's package conventions ([adding-a-package.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-package.md)) and ship the first release candidate since rc.0.

- [x] README: `## Model Experience` section in the harness canonical format (one H3 per model-context entry; ordered H4 fields `What the model sees` / `Token effect` / `KV Cache effect`) covering the `/compact-directive` summarization call, the `/trim-directive` operation-mode chunk calls, and the landed checkpoint; `## Known Limitations` renamed to `## Known Limitations and Deferred Work` with the Future items folded in; new `## Configuration` table (keepHeadUsers / keepTailUsers / summarizationProvider / summarizationModel / maxTokens); extension-points subsection (injected services, owned events, untouched upstream); usage examples in English (requirements accept any natural language)
- [x] docs/TODO.md: translate P10.2+ Chinese narration to English (real session names and verbatim user directives stay as quoted evidence); add this P13 section
- [x] docs/DONE.md: add the P12 entry (missing) and this P13 entry
- [x] CHANGELOG.md: add the P12 entry (delete-text / inflation guard / three real-run fix rounds); move Unreleased → `[0.1.0-rc.1]` with a date
- [x] package.json: version `0.1.0-rc.0` → `0.1.0-rc.1`
- [x] Agent Note `2026-08-16-operation-mode-trim.md`: add the real-run measurement (复杂对话4), plan B (prose reuse), and the pairing fix (closes the P11 open item)
- [ ] Release verification: `npm test` + `npm run build` green; `npm pack --dry-run` lists exactly the `files` whitelist
- [ ] Publish: `npm publish --tag rc` (maintainer); verify `dsh plugin --profile <name> add @ya8d/dsh-directive-compact@rc` resolves rc.1
