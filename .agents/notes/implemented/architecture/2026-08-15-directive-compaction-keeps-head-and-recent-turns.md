# Agent Note: directive compaction keeps the fixed head and recent turns

Status: implemented

## Problem

The first implementation (`@ya8d/dsh-compaction-directive`) drove directive summarization through the upstream `ctx.compaction` seam. That seam replaces the entire selected span — from `surfaceNodes[0]` — with one summary (`selectCompactableRange` starts at the first surface node). A directive like "删除 doc 相关的内容" therefore rewrote the whole span, including the user's original task message and the injected `agent-instructions` / `system-prompt` / `skill-catalog` nodes. Real-session measurement: 143 history items collapsed to one 3065-character summary; the task goal ("读取所有内容") disappeared. ContextForge's `compact_messages` / `compact_by_directive` paths avoid this by keeping the head and recent turns verbatim while summarizing only the middle.

## Decision

The plugin is a pure-incremental command plugin, not a compaction backend:

- **No inheritance, no single slot.** It does not extend `BasicCompactionEngine`, never registers `ctx.compaction`, and never listens to `agent/pre-step` — zero conflict with the upstream backend, in every preset and in headless.
- **Command:** `/compact-directive <requirement>` registered as a plain-context global command.
- **Head preservation:** the fixed head is the span before the first `assistant/message` or `tool/result` surface node — the first `user` message plus the injected `agent-instructions`, `system-prompt`, and `skill-catalog` nodes. These four are injected once at session start and are not re-injected per turn, so a compaction that drops them loses environment knowledge permanently. A previously compacted session may carry an older `compact` checkpoint before them; the head boundary is the first assistant/tool node regardless.
- **Middle summary, tail kept:** after the head, the span is split into turns (one user message with its assistant reply and tool results); the recent `keepRecentTurns` turns stay verbatim, and the middle turns are replaced by one checkpoint message via `session.append('user/message', …, { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs })`.
- **Two paths** (mirroring ContextForge `compact_now`):
  - Main path: middle turns exist and exceed the tail budget → keep head + summarize middle + keep recent turns, directive layered over the four-dimensional fallback prompt.
  - Degraded path: the main path finds no middle (too few turns) but a directive is present → keep head + summarize everything after it with the directive-only prompt.
- **Four-dimensional fallback** (from ContextForge `_SUMMARY_PROMPT`): the summary must preserve task goal, key steps taken, key findings/facts, and next steps, and every `[user]` original instruction verbatim. The directive is layered on top ("优先遵守"), never replaces the fallback.
- **Lifecycle events:** `compaction/start`, `compaction/summary`, `compaction/end` are appended so the operation is traceable; UI rendering of the before/after record is deferred.

## Alternatives considered

**Drive the directive through the `ctx.compaction` seam (the first implementation).** Reuses upstream locking/durability but forces whole-span replacement — the head and recent turns cannot be kept, and the directive rewrites the task goal away. Rejected.

**Copy `compactSurfaceRegion` internals to reuse the transaction.** The free functions are not exported from the published package (`lib/` has no `region.js`; `./src/*` ships no `src/`), so this would fork ~550 lines and drift. Rejected.

**Keep the engine class but set `auto: false`.** Inheritance still registers `ctx.compaction`, so headless must replace the upstream engine (not pure-incremental) and web's preset layer still conflicts. Rejected.

## Consequences

- The user's original task and the session's fixed context head survive any directive, no matter how aggressive the phrasing.
- The plugin coexists with the upstream backend in every preset and in headless with no single-slot or double-compaction risk.
- The summary is a middle-span replacement; the `compaction/directive-before-after` record is log-only and not rendered by the conversation UI (upstream UI only renders `compaction/summary` for automatic compaction and `command`/`manual-compaction` nodes).
- The degraded path summarizes the entire post-head span when the main path finds no middle — with only one or two turns this may not save tokens; it is still offered so a directive is honored even in short sessions.
