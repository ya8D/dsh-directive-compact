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

- [x] `src/plan.ts` — `headBoundaryIndex` (leading skeleton = compact checkpoint + injected nodes before the first user), `splitTurns` (retained for P3 balance checks), `planCompaction` (anchored on surface user utterances; keep head `keepHeadUsers` + tail `keepTailUsers` user turns verbatim, summarize the middle; defaults 3/3 via `PlanConfig`)
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

- [ ] Regression test: a cancelled/failed directive compaction leaves the surface intact (lifecycle closed, no partial replace)
- [ ] `cordis.patch.yml` — insert-only bundle row (currently declared in package.json; verify `--dump-config`)

## P5 — Bundle + verification

- [ ] `cordis.patch.yml` — insert-only (disables nothing), pure increment
- [ ] `--dump-config` verification
- [ ] With-key e2e: real DeepSeek model, self-skips without a key

## P6 — Documentation

- [ ] README final pass against shipped behavior
- [ ] Known Limitations current (before/after log-only, middle-span savings only, implementation status)
- [ ] This TODO fully checked off, DONE current

## Deferred / optional

- [ ] UI rendering of the `compaction/directive-before-after` comparison (upstream conversation UI change; requires a harness PR with its own Agent Note)
- [ ] With-key e2e: safety-refusal probe for aggressively negative directives on DeepSeek
