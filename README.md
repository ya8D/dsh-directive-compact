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

## Testing

Two commands, two suites:

- `npm test` — the unit suite (`tests/**/*.spec.ts`): planning, summarization, the command transaction, and the Loader composition. Needs no network or credentials.
- `npm run test:e2e` — the with-key e2e (`tests/directive-compact.e2e.ts`): one real directive-driven compaction against the DeepSeek public API. The e2e file is collected only under this command; `npm test` does not load it. The key resolves from `$DEEPSEEK_API_KEY`, then from the Harness credentials document at `$DSH_HOME/.credentials.yaml`, and the suite self-skips when neither supplies one.

## Command

- `/compact-directive <requirement>` — compact the middle of the conversation per your natural-language requirement, keeping the session head and the recent turns verbatim.

The requirement is plain free text. Prefer a positive frame ("keep / focus / downweight") over a negative one ("delete everything with …", "never appear"): aggressively negative phrasing reads as systematic record-removal and can trip the summarizer's safety refusal even when the intent is innocuous. The instruction is also passed through the model's ordinary safety judgment, so the same framing advice applies.

## How it works

The compaction keeps the fixed-skeleton head and the recent turns verbatim, and replaces the middle span with one checkpoint message. The summarization prompt layers your directive on top of a four-point baseline — task goal, key steps done, key findings, and next step — and requires every `[user]` original instruction to be preserved verbatim. The tail always covers the last user utterance and everything after it (an in-flight assistant stream or unpaired tool call survives), and `keepHeadUsers` / `keepTailUsers` extend the preserved regions further back.

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

- **Middle-span savings only.** The fixed head and recent turns are preserved by design, so a session with very little middle content saves little; the tail floor guarantees the last user utterance and its in-flight flow survive regardless.
- **No before/after rendering.** The transaction records the standard `compaction/start` / `compaction/summary` / `compaction/end` lifecycle in the session log; there is no dedicated before/after comparison event, and the conversation UI does not render the directive or its context. A log-visible `compaction/directive-before-after` comparison is deferred.
- **Clean-call summarization.** The summarization request is one focused user message with no system prompt or conversation prefix, so it does not reuse a warm-prefix KV cache. That is the deliberate trade of cache reuse for a more focused summary.
- **Implementation status.** The command, planning, and summarization implementation (P1–P4) is merged; bundle install and with-key e2e against the real DeepSeek API (P5) are verified. The package is not yet published to the npm registry, so installs must come from a local checkout or tarball.
