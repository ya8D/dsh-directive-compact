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

- [ ] Require the directive: empty `rawInput` returns an error directing the user to `/compact` (mirror of upstream's "no arguments" contract; no silent degradation to the weaker plain summary)
- [ ] Add shrink validation: the framed checkpoint must be smaller than the shadowed span (mirror of upstream's convergence check); fail with a `summary`-class error otherwise
- [ ] Confirm the middle-compaction differentiation stays (directive layering + head/tail protection are the value; upstream wins on KV cache and 8-section structure, so the no-directive path must not compete)
- [ ] With-key e2e already covers the directive path; add a shrink-rejection case (fake oversized summary)

## Deferred / optional

- [ ] UI rendering of the `compaction/directive-before-after` comparison (upstream conversation UI change; requires a harness PR with its own Agent Note)
- [ ] With-key e2e: safety-refusal probe for aggressively negative directives on DeepSeek
- [ ] With-key e2e for `/trim-directive` (real DeepSeek call, self-skips without a key)
