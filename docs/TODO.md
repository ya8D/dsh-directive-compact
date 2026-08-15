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

- [ ] `src/summarizer.ts` — four-point baseline prompt (task goal / done steps / findings / next step + verbatim `[user]` utterances), directive-layered prompt, directive-only degraded prompt, clean single-message call
- [ ] Unit tests: prompt construction (with/without directive), no-text rejection, image rejection, finish-error mapping
- [ ] Typecheck + build green

## P3 — Command transaction

- [ ] `src/command.ts` — `/compact-directive` handler: read session surface, plan spans, render middle, summarize, `session.append` replace with checkpoint source (`{ kind:'plugin', plugin:'compact', compactionId, sourceCommandId }`), `compaction/start`/`summary`/`end` lifecycle
- [ ] Unit tests: checkpoint message shape, lifecycle event sequence, error translation
- [ ] REAL-composition test: Loader boots cordis.yml, `/compact-directive` registered, `expect('default' in mod).toBe(false)`

## P4 — Plugin entry

- [ ] `src/index.ts` — `apply(ctx)` registers `/compact-directive` via `ctx.effect` (function plugin, no default export)
- [ ] HMR-safety test: dispose fiber → command unregistered
- [ ] Regression test: failed/cancelled directive compaction leaves no partial state

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
