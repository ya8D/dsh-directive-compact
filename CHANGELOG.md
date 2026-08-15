# Changelog

All notable changes to `@ya8d/dsh-directive-compact` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ya8D/dsh-directive-compact/compare/v0.1.0-rc.0...HEAD
[0.1.0-rc.0]: https://github.com/ya8D/dsh-directive-compact/releases/tag/v0.1.0-rc.0
