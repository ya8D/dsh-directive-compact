# @ya8d/dsh-directive-compact

A customized natural-language compaction plugin. It gives you the ability to precisely trim context — sometimes even to fix a malfunctioning context.

It registers `/compact-directive <requirement>` as a global command for DeepSeek Harness. The command keeps the session's fixed skeleton head (the first user message plus the injected `agent-instructions` / `system-prompt` / `skill-catalog` nodes) and the recent turns verbatim, and summarizes only the middle span according to your natural-language requirement — so an aggressive directive like "delete everything about doc" trims what you asked for without erasing the task anchor the model needs to keep working.

## Install

Install into a profile with the dsh CLI. `dsh plugin` forwards to pnpm in the profile directory, so a published package, a local checkout, or a tarball all work:

```sh
dsh plugin --profile <name> add @ya8d/dsh-directive-compact    # from the npm registry
dsh plugin --profile <name> add ./dsh-directive-compact         # from a local checkout
dsh plugin --profile <name> add ./dsh-directive-compact-0.1.0.tgz  # from a tarball
```

The package declares `dsh.bundle`, so `dsh plugin` activates its `cordis.patch.yml` layer automatically. The patch inserts this plugin's row; it disables nothing from the upstream composition.

`dsh plugin --profile <name> remove @ya8d/dsh-directive-compact` removes both the dependency and the layer.

> **Pure increment.** This plugin never touches `ctx.compaction`: it does not inherit `BasicCompactionEngine`, does not register the `compaction` single slot, and registers no automatic-compaction listeners. The upstream backend and `/compact` command stay exactly as they are; this plugin only adds one command.

## Command

- `/compact-directive <requirement>` — compact the middle of the conversation per your natural-language requirement, keeping the session head and the recent turns verbatim.

The requirement is plain free text. Prefer a positive frame ("keep / focus / downweight") over a negative one ("delete everything with …", "never appear"): aggressively negative phrasing reads as systematic record-removal and can trip the summarizer's safety refusal even when the intent is innocuous. The instruction is also passed through the model's ordinary safety judgment, so the same framing advice applies.

## How it works

The compaction follows two paths, both guaranteeing the model never loses the task anchor:

- **Primary path.** Keep the fixed-skeleton head and the recent `keepRecentTurns` turns verbatim; replace the middle span with one checkpoint message. The summarization prompt layers your directive on top of a four-point baseline — task goal, key steps done, key findings, and next step — and requires every `[user]` original instruction to be preserved verbatim.
- **Degraded path.** When the primary path finds no middle span (too few turns) but a directive is present, keep the fixed-skeleton head and summarize everything after it under a pure directive prompt.

The head is the session's fixed skeleton, not merely the first message: every DeepSeek Harness session opens with the same four nodes — the user's first message, the `agent-instructions` injection, the `system-prompt` snapshot, and the `skill-catalog` listing. These four nodes appear once at session start, are not re-injected per turn, and are not restored after a replacement, so they are preserved.

The middle-span replacement is performed through `session.append` with `surfaceOp: { op: 'replace' }`, so the session's own append validation (surface provenance, source-event coverage, tool-result rewrite rules) still enforces integrity at the write boundary.

## Model Experience

### What the model sees

A directive-driven compaction replaces the middle span with one checkpoint user message. The checkpoint carries the directive in a marker and a guard stating that removed content was removed on purpose and must not be reconstructed. The session head and recent turns are untouched, so the model's next request still contains the task anchor and the latest work.

### Token effect

The directive adds its own tokens to the auxiliary summarization request and to the checkpoint that lands in the conversation. The session head (AGENTS.md + system prompt + skill catalog) is large and preserved verbatim, so savings are bounded to the middle span — the same trade the reference design makes.

### KV Cache effect

A positional replacement invalidates reuse from the first replaced history token onward, exactly as the upstream compaction backend does. The unchanged head before that range remains reusable.

## Known Limitations and Deferred Work

- **Middle-span savings only.** The fixed head and recent turns are preserved by design, so a session with very little middle content saves little; the degraded path still honors a directive by summarizing everything after the head.
- **Log-only trace.** The directive and its before/after context are recorded in `compaction/directive-before-after`, which is log-only and not rendered by the conversation UI. UI rendering of the before/after comparison is deferred.
- **Implementation status.** This package is under active development: the P0 scaffold is committed; the command, planning, and summarization implementation (P1–P6) are in progress. Install and usage above describe the intended contract, not yet fully shipped behavior.
