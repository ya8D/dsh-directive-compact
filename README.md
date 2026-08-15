# @ya8d/dsh-directive-compact

A natural-language compaction plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It lets you tell the agent — in plain language — what to keep, what to drop, and how to compress an existing conversation.

Designed for large-context models (1M-token window, e.g. `deepseek-v4-flash`).

## Commands

| Command | What it does |
|---|---|
| `/compact-directive <requirement>` | Compresses the **middle** of the conversation. Keeps the session's fixed head (first user message + injected `agent-instructions` / `system-prompt` / `skill-catalog`) and the recent turns verbatim; summarizes everything between them per your requirement. |
| `/trim-directive <requirement>` | Trims the **whole conversation** per your requirement, with **no region protection**. The escape hatch when the directive must reach protected content — including the head. |

> **⚠️ Destructive — fork first.** A trim/compaction permanently removes content from the model-visible conversation. There is no undo and no minimum retention. The original text is *not* lost (the session log is append-only and records every removed node), but restoring it needs tooling. **Fork the session before destructive experiments.**

## Install

```sh
dsh plugin --profile <name> add @ya8d/dsh-directive-compact   # npm registry
dsh plugin --profile <name> add ./dsh-directive-compact        # local checkout
```

The package declares `dsh.bundle`, so the plugin row is activated automatically and nothing from the upstream composition is disabled. Remove with `dsh plugin --profile <name> remove @ya8d/dsh-directive-compact`.

This plugin is a **pure increment**: it never touches the upstream `ctx.compaction` slot, never registers automatic-compaction listeners, and leaves `/compact` exactly as it is.

## Usage

Both requirements are plain free text.

**`/compact-directive`** — the requirement is mandatory (an empty one returns a usage error). Example:

```
/compact-directive 保留登录相关的报错，压缩其余中间过程
```

**`/trim-directive`** — the requirement decides everything that survives. Example:

```
/trim-directive 删除所有关于 git 操作的记录，保留用户原始指令和插件开发目标
```

### How the two differ

| | `/compact-directive` | `/trim-directive` |
|---|---|---|
| Region | Middle only; head + recent turns protected | Everything after the system nodes; **nothing protected** |
| Baseline | Requirement layered over a four-point summary baseline | Requirement is the sole instruction (no baseline) |
| Result | One checkpoint replacing the middle | One checkpoint replacing the whole trim-able range |
| Use case | Routine context compression with a focus | Aggressive / surgical deletion the head-protected command cannot reach |

### What is never trimmed

The injected system nodes (`agent-instructions`, `system-prompt`, `skill-catalog`) are session machinery, not dialogue — they are never trim-able and stay outside both the prompt and the replaced range.

### Where the command and its effect appear

- **Commands are log-only, not dialogue.** Like every dsh slash command (including upstream `/compact`), these commands do not appear as messages in the conversation UI. The invocation, result, and compaction lifecycle are visible in the **session trace/log**.
- **The original dialogue stays visible in the UI after a trim/compaction.** The conversation transcript never erases what you already saw (dsh's design; upstream `/compact` behaves the same). The **model** uses the checkpointed context on its next request — to verify the effect, read the session trace, not the chat transcript.

## Known Limitations

- **Large conversations are handled automatically.** Every summarization call is bounded to the routed model's context window. On the 1M window: output capped at 256K, per-chunk input at 200K, up to 10 chunks summarized in **parallel** and assembled into one checkpoint with `[part N/M]` dividers. Input beyond the window fails loud. A transient failure on one chunk retries it (up to 3 attempts); cancellation is never retried.
- **Thinking is not disabled, so a trim can take tens of seconds to minutes.** The model reasons about your requirement before writing the trimmed context (deliberately — disabling reasoning would hurt the cut decisions).
- **Model judgment is the trim's engine — and its limit.** The model decides what survives from the rendered dialogue. It generally follows the requirement, but it is *not* a deterministic per-node delete: a surgical instruction ("delete exactly this one message") can be interpreted as a broader compression, and an ambiguous requirement may yield an unexpected result. Check the session trace after a trim.
- **System nodes are never trimmed.** The injected `agent-instructions` / `system-prompt` / `skill-catalog` nodes are session machinery, not dialogue — they stay outside both the prompt and the replaced range, as does the session's opening anchor (a structural consequence of the contiguous replacement).
- **No before/after rendering in the UI.** The conversation transcript never erases what you already saw (see [Where the command and its effect appear](#where-the-command-and-its-effect-appear)); to see the trim's effect, read the session trace.

## Development

```sh
npm test            # unit suite (no network/credentials)
npm run test:e2e    # real DeepSeek calls; self-skips without a key
npm run build       # tsc → lib/
```

## License

MIT
