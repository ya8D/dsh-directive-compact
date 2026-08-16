# Changelog

All notable changes to `@ya8d/dsh-directive-compact` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-rc.1] - 2026-08-16

### Added

- **Operation-mode trim (P11)**: `/trim-directive` chunks now run in operation mode first — the model sees numbered nodes (`[seq N] [role] …`, reusing the harness's global event seq) and replies with a small delete/rewrite/summarize manifest instead of regenerating the whole context. The plugin executes the manifest programmatically: untouched nodes splice **verbatim** (zero generation — 100% fidelity, no drift), deleted nodes drop, rewritten nodes take the model's content, summarized ranges take the summary. Only changed nodes spend time in the model. Any malformed/uncertain manifest (prose, unknown ops, out-of-range seqs, overlaps, split tool pairs, missing content) falls back to the existing rewrite mode — never half-executed.
- **`delete-text` operation (P12)**: `/trim-directive`'s operation mode now accepts `delete-text: <seq>, "<exact fragment>"` — the plugin deletes the cited fragment by exact string match, zero generation and zero inflation for in-node removals. A fragment that does not appear in the node's rendering is conservatively dropped (the node keeps its original text); out-of-range seqs and overlaps reject.
- **Rewrite inflation guard (P12)**: a `rewrite` whose output is larger than the original node (ratio > 1.1) is dropped from the manifest and the node keeps its original text — the model cannot "shrink" a session while inflating individual nodes.
- Trim no-change declaration (speed): the trim prompt asks the model to first judge whether the requirement changes its chunk at all; if nothing does, the model replies with exactly `<<NO_CHANGE>>` and the command layer keeps that chunk's **original rendering verbatim** in the checkpoint instead of paying the model to regenerate it. Only chunks with real changes spend time in the model — a large-surface trim whose requirement matches little (e.g. "delete telemetry" in a session with almost none) now costs only the changed chunks, not a full ~350K-token rewrite. A marker buried in other output is treated as content, never as a declaration, so the marker cannot be abused to silently drop content.
- Phase logging for both commands through the Cordis logger service under the `dsh-directive-compact` scope (matching the upstream `compaction-basic` convention): `info` milestones with timings (begin / per-chunk done / all-chunks done / committed, each with elapsed ms and token counts), `warn` on failures and per-chunk retries, and `debug` for call time-to-first-chunk / stream duration and chunk geometry. README documents what each line means and how to enable debug.

### Changed

- **Operation-mode prose reuse (P11 fix, real-run driven)**: when the model replies with prose instead of an operation manifest, its output IS its rewrite of the chunk and is now reused directly — no second rewrite call. The op-mode prompt now explicitly allows both forms (FORM 1 manifest, preferred; FORM 2 full rewrite). A parseable-but-invalid manifest (out-of-range seqs, overlaps, split tool pairs — rare) still falls back to one rewrite call, because a manifest is not usable as content. Real "复杂对话4" run had the model emit prose on 9/9 chunks and the old fallback cost TWO rewrite calls per chunk → 13.8 min (2.3× the rewrite baseline); the fix restores at most one rewrite per chunk.
- **Tool-pair tolerance in operation mode (P11 fix, real-log driven)**: rewrite of a tool-result/text node is allowed directly (only rewrite of a tool-call node is rejected, since its result would dangle); a one-sided `delete`/`summarize` (call only or result only) auto-includes the paired node by callId within the chunk — deleting a result deletes the whole tool record with zero extra LLM calls. A backticked `` `<<NO_CHANGE>>` `` is recognized as a no-change declaration.
- **`delete-text` parsing tolerates real model output (P12, real-run driven)**: quoted fragments with `\"` escapes, unclosed quotes, and bare fragments parse; `\\` stays literal (Windows paths); leading indentation is stripped before matching; repeated operation lines dedup and cross-operation overlaps merge conservatively (delete-text > rewrite > delete).
- An unshrunk checkpoint is now a **no-change success instead of a failure**: when the model's output is not smaller than the span it would replace (typically it found nothing worth removing and returned the context essentially verbatim), `/trim-directive` and `/compact-directive` record the output in the compaction lifecycle (`start` → `summary` → `end`, no surface replace), leave the conversation untouched, and report `Nothing to trim: …` / `Nothing to compact: …`. Previously this threw a `summary`-class error; combined with a large surface it could also churn through retries on a rewrite that cannot shrink. This closes the "delete telemetry that is not there" hang observed on "复杂对话 (1)".
- `/trim-directive` chunk budget is now fixed rather than window-derived: per-chunk input 50K (was `window/5` = 200K on the 1M window), max 20 chunks (was 10). The plugin targets the 1M-window DeepSeek models. A single ~200K-token summarization call could take 10+ minutes or hang (observed on a real 178K-token session); 50K chunks are ~4× smaller, complete faster, and stay independently retriable. Total input beyond 20 × 50K = 1M still fails loud ("compact the session first").

## [0.1.0-rc.0] - 2026-08-15

### Added

- `/compact-directive <requirement>` — summarize the session's middle span per a natural-language requirement, keeping the fixed skeleton head and recent turns verbatim.
- `/trim-directive <requirement>` — hand the whole conversation to the model with a directive-only prompt and zero dialogue-region protection; the requirement decides what survives.
- Budgeted chunked compression: every trim summarization call is bounded to the routed model's context window (output cap `min(window/2, 256K)`, per-chunk input `window/5`, up to 10 parallel chunks assembled into one checkpoint with `[part N/M]` dividers).
- Per-chunk retry: a transient failure on one chunk retries it up to 2 extra times (3 attempts total); cancellation and expected compaction failures are never retried.
- With-key e2e suite (`npm run test:e2e`), self-skipping without `$DEEPSEEK_API_KEY`.

### Changed

- `/compact-directive` requires the directive: an empty invocation returns a usage error pointing at `/compact`.
- Shrink validation: a checkpoint must be smaller than the span it replaces, mirroring the upstream convergence check.
- Injected system nodes (`agent-instructions` / `system-prompt` / `skill-catalog`) are never trim-able.

### Security

- MIT licensed; the plugin is a pure increment — it never touches the upstream `ctx.compaction` slot and registers no automatic-compaction listeners.

[Unreleased]: https://github.com/ya8D/dsh-directive-compact/compare/v0.1.0-rc.1...HEAD
[0.1.0-rc.1]: https://github.com/ya8D/dsh-directive-compact/compare/v0.1.0-rc.0...v0.1.0-rc.1
[0.1.0-rc.0]: https://github.com/ya8D/dsh-directive-compact/releases/tag/v0.1.0-rc.0
