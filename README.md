# @ya8d/dsh-directive-compact

A customized natural-language compaction plugin. It gives you the ability to precisely trim context — sometimes even to fix a malfunctioning context.

It registers two global commands for DeepSeek Harness:

- `/compact-directive <requirement>` — keeps the session's fixed skeleton head (the first user message plus the injected `agent-instructions` / `system-prompt` / `skill-catalog` nodes) and the recent turns verbatim, and summarizes only the middle span according to your natural-language requirement — so an aggressive directive like "delete everything about doc" trims what you asked for without erasing the task anchor the model needs to keep working.
- `/trim-directive <pattern>` — deletes every surface node whose rendered text matches the pattern, with **zero region protection**. This is the escape hatch when the directive must reach protected content: "delete all context about X" works even when X lives in the head, because trim has no head.

## Install

Install into a profile with the dsh CLI. `dsh plugin` forwards to pnpm in the profile directory, so a published package, a local checkout, or a tarball all work:

```sh
dsh plugin --profile <name> add @ya8d/dsh-directive-compact    # from the npm registry
dsh plugin --profile <name> add ./dsh-directive-compact         # from a local checkout
dsh plugin --profile <name> add ./dsh-directive-compact-0.1.0.tgz  # from a tarball
```

The package declares `dsh.bundle`, so `dsh plugin` activates its `cordis.patch.yml` layer automatically. The patch inserts this plugin's row; it disables nothing from the upstream composition.

`dsh plugin --profile <name> remove @ya8d/dsh-directive-compact` removes both the dependency and the layer.

> **Pure increment.** This plugin never touches `ctx.compaction`: it does not inherit `BasicCompactionEngine`, does not register the `compaction` single slot, and registers no automatic-compaction listeners. The upstream backend and `/compact` command stay exactly as they are; this plugin only adds two commands.

## Testing

Two commands, two suites:

- `npm test` — the unit suite (`tests/**/*.spec.ts`): planning, summarization, both command transactions, and the Loader composition. Needs no network or credentials.
- `npm run test:e2e` — the with-key e2e (`tests/directive-compact.e2e.ts`): one real directive-driven compaction against the DeepSeek public API. The e2e file is collected only under this command; `npm test` does not load it. The key resolves from `$DEEPSEEK_API_KEY`, then from the Harness credentials document at `$DSH_HOME/.credentials.yaml`, and the suite self-skips when neither supplies one.

## Command

- `/compact-directive <requirement>` — compact the middle of the conversation per your natural-language requirement, keeping the session head and the recent turns verbatim. The requirement is required: an empty invocation returns a usage error pointing at `/compact`, which is the plain (no-requirement) summarization command.
- `/trim-directive <requirement>` — hand the whole conversation to the model and trim it per your natural-language requirement. No dialogue region is protected: the requirement alone decides what survives, down to nothing.

The compact-directive requirement is plain free text. Prefer a positive frame ("keep / focus / downweight") over a negative one ("delete everything with …", "never appear"): aggressively negative phrasing reads as systematic record-removal and can trip the summarizer's safety refusal even when the intent is innocuous. The instruction is also passed through the model's ordinary safety judgment, so the same framing advice applies.

The trim-directive requirement is also plain free text ("delete everything about doc, keep only the login flow"). The model applies it directly with a directive-only prompt — no summarization baseline is layered on top, so the requirement is honored as written. The injected system nodes (`agent-instructions` / `system-prompt` / `skill-catalog`) are never trim-able: they are session machinery, not dialogue, and are kept outside both the prompt and the replaced range.

## How it works

### `/compact-directive`

The compaction keeps the fixed-skeleton head and the recent turns verbatim, and replaces the middle span with one checkpoint message. The summarization prompt layers your directive on top of a four-point baseline — task goal, key steps done, key findings, and next step — and requires every `[user]` original instruction to be preserved verbatim. The tail always covers the last user utterance and everything after it (an in-flight assistant stream or unpaired tool call survives), and `keepHeadUsers` / `keepTailUsers` extend the preserved regions further back. A shrink check rejects a checkpoint that is not smaller than the span it replaces (mirror of the upstream convergence check); the attempt is recorded in the session log and the conversation is unchanged.

The head is the session's fixed skeleton, not merely the first message: every DeepSeek Harness session opens with the same four nodes — the user's first message, the `agent-instructions` injection, the `system-prompt` snapshot, and the `skill-catalog` listing. These four nodes appear once at session start, are not re-injected per turn, and are not restored after a replacement, so they are preserved.

### `/trim-directive`

The trim renders the trim-able dialogue (everything after the injected system nodes) and sends it to the model with a directive-only prompt. The model's output replaces the whole trim range as one checkpoint through the standard summarizing lifecycle — `compaction/start` (standalone) → `compaction/summary` → `user/message` replace → `compaction/end`. A shrink check rejects a checkpoint that is not smaller than the span it replaces, and the range boundaries are tool-pairing balanced so a tool-call/result pair is never split.

Because the injected nodes sit between the first user message and the rest of the conversation, the trim range starts after them — the opening anchor (first user message) stays outside the range as a structural consequence of that contiguous replacement, not as a protection policy. Everything after the skeleton is trim-able.

Both middle-span replacement and trim are performed through `session.append` with `surfaceOp: { op: 'replace' }`, so the session's own append validation (surface provenance, source-event coverage, tool-result rewrite rules) still enforces integrity at the write boundary.

## Model Experience

### What the model sees (compact-directive)

A directive-driven compaction replaces the middle span with one checkpoint user message. The checkpoint carries the directive in a marker and a guard stating that removed content was removed on purpose and must not be reconstructed. The session head and recent turns are untouched, so the model's next request still contains the task anchor and the latest work.

### What the model sees (trim-directive)

A trim sends the trim-able dialogue to the model with a directive-only prompt; the model's output replaces the whole trim range as one checkpoint carrying a `[Directive trim, per requirement: <requirement>]` marker and a guard stating that removed content was removed on purpose. The injected system nodes and the opening anchor stay outside the range, so the model keeps its environment; everything after them is gone from the model's view. Zero dialogue protection means a broad requirement can strip the session down to just the skeleton and the checkpoint — the model may lose its task anchor, which is exactly what the user asked for.

### Token effect

The directive adds its own tokens to the auxiliary summarization request and to the checkpoint that lands in the conversation. The session head (AGENTS.md + system prompt + skill catalog) is large and preserved verbatim, so compact-directive savings are bounded to the middle span — the same trade the reference design makes. Trim spends one summarization call and unconditionally reduces the trim-able surface.

### KV Cache effect

A positional replacement invalidates reuse from the first replaced history token onward, exactly as the upstream compaction backend does. The unchanged head before that range remains reusable.

## Known Limitations and Deferred Work

- **Middle-span savings only (compact-directive).** The fixed head and recent turns are preserved by design, so a session with very little middle content saves little; the tail floor guarantees the last user utterance and its in-flight flow survive regardless. The directive cannot delete protected content — use `/trim-directive` for that.
- **Shrink validation can reject small spans (compact-directive).** A checkpoint must be smaller than the span it replaces; a verbose model summary over a small middle span can exceed it, so the compaction is rejected (recorded in the log, conversation unchanged). This mirrors the upstream convergence check and mainly affects tiny middles — real long sessions compress comfortably.
- **Zero protection is the point (trim-directive), and the risk.** A broad or accidental requirement can delete content the user still needs, down to a session holding only the injected skeleton and the checkpoint. There is no undo and no minimum dialogue retention; check the requirement before running it.
- **Model judgment (trim-directive).** The model decides what survives from the rendered dialogue. It generally follows the requirement, but an ambiguous or self-contradictory requirement may yield an unexpected trim; there is no deterministic per-node guarantee.
- **System nodes always preserved.** The injected `agent-instructions` / `system-prompt` / `skill-catalog` nodes are session machinery, never trim-able; the trim range starts after them, so the opening anchor (first user message) stays outside the range too.
- **No before/after rendering.** The transactions record the standard lifecycle (`compaction/start` / `compaction/summary` / `compaction/end`) in the session log; there is no dedicated before/after comparison event, and the conversation UI does not render the directive or its context. A log-visible `compaction/directive-before-after` comparison is deferred.
- **Clean-call summarization (compact-directive).** The summarization request is one focused user message with no system prompt or conversation prefix, so it does not reuse a warm-prefix KV cache. That is the deliberate trade of cache reuse for a more focused summary.
- **Implementation status.** The command, planning, and summarization implementation (P1–P7) is merged, including the AI-driven free-trim command (P6) and the compact-directive polish (P7: required directive, shrink validation). The package is not yet published to the npm registry, so installs must come from a local checkout or tarball.
