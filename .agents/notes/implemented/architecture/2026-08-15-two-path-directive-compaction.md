# Agent Note: Two-path directive compaction with a fixed-skeleton head

Status: implemented

## Problem

The first implementation (`@ya8d/dsh-compaction-directive`) reused dsh's `ctx.compaction` seam to drive a directive-driven summary. The seam's `compactSurfaceRegion` replaces a token-budget-selected range wholesale: `selectCompactableRange` anchors at `surfaceNodes[0]` and folds the entire span into one checkpoint node. A user directive therefore steers how the *whole* span is rewritten, not what is kept. In a real test, `/compact 删除doc目录下的所有信息` collapsed a 143-item span (≈1.2M characters) into a single doc-catalog listing — the user's original task message, the injected AGENTS.md rules, the runtime context snapshot, and the skill catalog all disappeared with it. The directive's intent ("drop doc details") was honored, but the session lost every anchor that lets the model resume the task.

ContextForge solves the same problem with a two-path design. Its `compact_messages` keeps the head (first user message) and the recent turns verbatim, summarizes only the middle, and overlays the user directive on a four-point baseline (task goal / done steps / findings / next step, plus verbatim user utterances). Its `compact_by_directive` degrades to keeping only the first user message and compressing the rest under a pure directive prompt. Both paths guarantee the model never loses the task anchor.

## Decision

**`@ya8d/dsh-directive-compact` does not touch `ctx.compaction`. It is a pure function plugin that registers the global command `/compact-directive <requirement>`, reads the session surface itself, and replaces the middle span through `session.append` with `surfaceOp: { op: 'replace' }`.** It inherits nothing from `BasicCompactionEngine`, registers no `ctx.compaction` slot, and registers no automatic-compaction listeners, so it coexists with the upstream backend unchanged.

The compaction keeps a head and a tail verbatim and summarizes the middle span between them, anchored on **surface user utterances** (`user/message` with `source.kind === 'user'`):

- **Head**: the fixed-skeleton injections (an older `compact` checkpoint plus any `agent-instructions` / `system-prompt` / `skill-catalog` nodes before the first user) and the first `keepHeadUsers` user utterances' full turns (default 3).
- **Tail**: everything from the `keepTailUsers`-from-last user utterance on (default 3), including any in-flight assistant stream or unpaired tool call. This honors the requirement that the user's latest request and its in-progress execution survive, and guarantees the middle never splits an open tool pair.
- **Middle**: the user turns between the head and tail, replaced by one checkpoint message. No-op when fewer than `keepHeadUsers + keepTailUsers` user utterances exist.
- **Anchoring on surface user utterances, not on log `turn/start`/`turn/end` markers**: a prior compaction folds an earlier span into a `compact` checkpoint node, so the log still carries the old turn markers while the surface no longer has their content. Real-session analysis of a twice-compacted session (101 turn markers in the log, surface anchored on 57 live user utterances) confirmed that turn markers cannot locate "which turn" on the current surface; user anchors are what remain model-visible and stay correct across repeated compaction.
- The summarization prompt overlays the user directive on a four-point baseline (task goal / done steps / findings / next step) and requires verbatim preservation of every `[user]` utterance.

**The head includes the session's fixed skeleton, not merely the first message.** A real-session survey (14+ sessions, including a fresh one-turn session) established that every DeepSeek Harness session opens with the user's first message followed by the `agent-instructions` injection, the `system-prompt` snapshot, and the `skill-catalog` listing. These nodes appear once at session start, are not re-injected per turn, and are not restored after a replacement — folding them into a summary discards the environment knowledge the model works under. After a prior compaction, a `compact` checkpoint precedes them and is absorbed into the skeleton (it is a non-`user`-sourced `user/message`).

The transaction records the standard `compaction/start` / `compaction/summary` / `compaction/end` lifecycle so the operation remains reconstructable from the session log; the checkpoint message carries `{ kind: 'plugin', plugin: 'compact', compactionId, sourceCommandId }` per the seam's checkpoint protocol. The directive itself appears only in the summarization prompt and the checkpoint marker; there is no dedicated before/after comparison event.

## Alternatives considered

### Reuse `ctx.compaction` and subclass `BasicCompactionEngine`

The first implementation did this. It inherits the full official transaction (locking, convergence, shrink validation, durability) but is locked into the seam's wholesale-replacement semantics: the range is token-budget-selected and the entire span is replaced, with no keep-head / keep-recent option. Overriding `summarize()` changes only what the summary says, not which nodes survive. Also, inheriting the engine registers the `ctx.compaction` single slot, which conflicts with the official backend in the same realm (headless base layer) and forces a replacement decision the pure-increment goal rejects.

### Import the seam's internal free functions (`compactSurfaceRegion` / `selectCompactableRange`)

These functions are not a public API. `@deepseek-ai/dsh-compaction-basic` exports only `BasicCompactionEngine` from its root; the `./src/*` subpath points at TypeScript sources that are absent from the published `files` list. Reusing them would depend on unpublished internals that can move freely in the rc phase.

### Copy the seam's region logic into this package

Copying `compactSurfaceRegion` would duplicate the official transaction (locking, stability checks, durability) and drift as the upstream moves. The pure-increment goal wants the opposite: keep the plugin thin and let the session's own append validation enforce surface integrity.

### Keep a degraded path (compress everything after the head)

ContextForge's `compact_by_directive` compresses everything after the first user message when there are too few turns for a structured middle. In this package, the tail floor (last user utterance preserved verbatim) makes such a path either fold the last user utterance — violating the tail floor — or find nothing to compress, so it is unreachable and was dropped. `planCompaction` returns `none` when no middle exists.

### Locate turn boundaries with the log's `turn/start` / `turn/end` events

dsh logs a numbered turn per user-driven exchange, and the events are precise (`turn/start` before the user message, `turn/end` after the assistant reply). But compaction operates on the surface, not the log: a prior compaction folds an earlier span into a `compact` checkpoint while the log's turn markers remain. Analysis of a twice-compacted session showed 101 turn markers in the log while the surface anchored on 57 live user utterances — "the Nth turn" is meaningless on the current surface after a compaction. Surface user-utterance anchors were chosen instead; they are what remain model-visible and stay correct across repeated compaction.

## Consequences

The plugin is purely additive: no `ctx.compaction` slot is taken, no automatic-compaction listener is registered, and the upstream backend and `/compact` command are untouched. The cost is that the plugin implements its own range selection and transaction recording rather than inheriting them — it reads the session surface and appends the `compaction/*` lifecycle itself. The session's own append validation (surface provenance, source-event coverage, tool-result rewrite rules) still enforces integrity at the write boundary, so the plugin does not re-implement safety, only the decision of what to replace.

The four-node head is preserved verbatim, which costs tokens (AGENTS.md + system prompt + skill catalog are large) but buys continuity: the model keeps its environment knowledge and the task anchor across compaction. The `keepHeadUsers` / `keepTailUsers` user turns (default 3 each) are likewise preserved, bounding the plugin's savings to the middle span — the same trade ContextForge makes.
