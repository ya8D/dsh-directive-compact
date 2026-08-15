# DONE

Completed development steps, most recent last.

## Decisions

- Package name: `@ya8d/dsh-directive-compact` (replaces the earlier `@ya8d/dsh-compaction-directive`; the old repository is retired).
- Pure increment: the plugin never touches `ctx.compaction` — no `BasicCompactionEngine` inheritance, no single-slot registration, no automatic-compaction listeners. The upstream backend and `/compact` stay untouched.
- Command: `/compact-directive <requirement>` — a global command, registered in a plain context so every preset and headless see it.
- Two-path compaction (ContextForge semantics): primary keeps the fixed-skeleton head + recent turns and summarizes the middle with a directive layered over a four-point baseline; degraded keeps the head and summarizes the rest under a pure directive prompt when no middle exists.
- Fixed-skeleton head: the first `user` message plus the injected `agent-instructions` / `system-prompt` / `skill-catalog` nodes — established by a real-session survey (14+ sessions, including a fresh one-turn session). These nodes appear once at session start, are not re-injected per turn, and are not restored after a replacement, so they are preserved.
- Middle-span replacement through `session.append` with `surfaceOp: { op: 'replace' }`; session-side append validation (provenance, source-event coverage, tool-result rewrite rules) enforces integrity.
- Lifecycle events `compaction/start` / `compaction/summary` / `compaction/end` are appended; the checkpoint message carries `{ kind: 'plugin', plugin: 'compact', compactionId, sourceCommandId }`.
- Workflow: the agent creates branches and commits; the maintainer (ya8D) pushes and opens PRs.

## Steps

- [x] P0: scaffolded the new repository at `C:\AI\dsh-directive-compact` (independent of the retired `C:\AI\dsh-compaction-directive`).
- [x] P0: `package.json` (`@ya8d/dsh-directive-compact`, ESM, `dsh.bundle`, minimal peers, `files` whitelist), tsconfigs (strict NodeNext), vitest configs, `LICENSE`, `.gitignore`.
- [x] P0: `src/invariant.ts` (no-runtime-invariant companion with reason), `src/index.ts` (function-plugin skeleton, no default export).
- [x] P0: repo standards — `AGENTS.md`, `docs/AGENTS.md`, `.agents/notes/README.md`; committed as `5d8b956`.
- [x] P0: Agent Note `implemented/architecture/2026-08-15-two-path-directive-compaction.md` — records the keep-head-and-recent-turns design and its alternatives (a duplicate note I drafted was deleted in favor of this one).
- [x] P0: README — contract, install (`dsh plugin add`), command, Model Experience, Known Limitations, implementation status; committed on `feat/readme` as `832a847` (awaiting maintainer push/PR).
- [x] P0: `docs/TODO.md` / `docs/DONE.md` workflow log.
- [x] P1: `src/plan.ts` — pure range-planning functions: `headBoundaryIndex` (fixed-skeleton head = first user utterance + following injected system nodes), `splitTurns` (user-led turns), `planCompaction`. Deliberately session-free (input is a flat node description) so every decision is unit-testable; balance checking is deferred to the command layer (P3) where the `Session` is available.
- [x] P1: `tests/plan.spec.ts` — 21 tests: head boundary (fresh / compacted / empty / injected-follow), turn splitting, middle selection, tail floor, `keepRecentTurns=0` edge. Fixed a `-0` slice trap in `planCompaction` (`slice(0, -0)` returns empty) and a wrong test expectation.
- [x] P1: design refinement — the tail always covers the last user utterance and everything after it (in-flight assistant stream / unpaired tool call survive), so `keepRecentTurns` only extends the tail further back. This makes the planned degraded path unreachable, so the design is single-path; the Agent Note was updated to match.
- [x] P1: review corrections — dropped the unused `hasDirective` parameter (no current owner; YAGNI), replaced the hard-coded system-node kind enumeration with a `kind !== 'user'` injection test (robust to upstream node-name changes and to a preceding `compact` checkpoint), and documented the tail-floor invariant on `planCompaction` (tail non-empty whenever a user utterance exists; a no-user conversation may have an empty tail).
- [x] P1: design change — turn-marker localization was falsified by real data. A twice-compacted session keeps 101 `turn/start`/`turn/end` markers in the log while its surface anchors on 57 live user utterances; "the Nth turn" is meaningless after compaction. `planCompaction` now anchors on surface user utterances with configurable `keepHeadUsers` (default 3) and `keepTailUsers` (default 3) via `PlanConfig`; a prior `compact` checkpoint is absorbed into the skeleton head. Verified on the real session: head 46 nodes, middle 974, tail 23, last user in tail.
- [x] P1: typecheck + build green; committed on `feat/P1-planning` (awaiting maintainer push/PR).
