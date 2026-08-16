# @ya8d/dsh-directive-compact

A natural-language compaction plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): tell the agent — in plain language — what to keep, what to drop, and how to compress an existing conversation. Designed for large-context models (1M-token window, e.g. `deepseek-v4-flash`).

## Commands

| Command | What it does |
|---|---|
| `/compact-directive <requirement>` | Compresses the **middle** of the conversation. Keeps the session's fixed head (first user message + injected `agent-instructions` / `system-prompt` / `skill-catalog`) and the recent turns verbatim; summarizes everything between them per your requirement. The requirement is mandatory — an empty one returns a usage error. |
| `/trim-directive <requirement>` | Trims the **whole conversation** per your requirement, with **no region protection and no system-node protection** — any content can be deleted by natural-language instruction, including the head, the injected skeleton, and anything `/compact-directive` cannot reach. |

> **⚠️ Destructive — fork first.** A trim/compaction permanently removes content from the model-visible conversation. There is no undo and no minimum retention. The original text is *not* lost (the session log is append-only and records every removed node), but restoring it needs tooling. **Fork the session before destructive experiments.**

## Install

The `dsh` CLI is the entry point. How you invoke it depends on your setup:

- If `dsh` is on your `PATH` (a global install), call it directly: `dsh plugin ...`.
- In a DeepSeek Harness checkout, use the workspace wrapper: `pnpm dsh ...` (or `npx dsh ...`).

Install into a profile (replace `<name>` with `web`, `headless`, or your own):

```sh
dsh plugin --profile <name> add @ya8d/dsh-directive-compact        # npm registry (latest)
dsh plugin --profile <name> add @ya8d/dsh-directive-compact@rc     # npm registry (release candidate)
dsh plugin --profile <name> add ./dsh-directive-compact            # local checkout
```

The package declares `dsh.bundle`, so the plugin row is activated automatically and nothing from the upstream composition is disabled — the plugin is a pure increment (it never touches the upstream `ctx.compaction` slot or `/compact`). Remove with `dsh plugin --profile <name> remove @ya8d/dsh-directive-compact` (or the matching `pnpm dsh ...` / `npx dsh ...` form).

## Usage

Both requirements are plain free text **in any natural language**. Examples:

```
/compact-directive keep the login-related errors, compress the rest of the middle process
/trim-directive delete all git-operation records, keep the user's original instructions and the plugin-development goal
```

### How the two differ

| | `/compact-directive` | `/trim-directive` |
|---|---|---|
| Region | Middle only; head + recent turns protected | **The whole surface; nothing protected** |
| Baseline | Requirement layered over a four-point summary baseline | Requirement is the sole instruction (no baseline) |
| Result | One checkpoint replacing the middle | One checkpoint replacing the whole surface |
| Use case | Routine context compression with a focus | Aggressive / surgical deletion the head-protected command cannot reach |

### Operation mode (how a trim actually cuts)

`/trim-directive` runs every chunk in **operation mode**: the model sees each node numbered with its global event seq (`[seq 28039] [user] …`) and replies with a small **operation manifest**:

```
delete: 28039, 28045          remove whole nodes
delete-text: 28039, "..."     delete an exact fragment inside one node
rewrite: 28039                replace one node (partial edits) → its full new text
summarize: 28040-28045        replace a range with a short summary
---content--- … ---end---     (the replacement text for rewrite/summarize)
<<NO_CHANGE>>                 nothing to change in this chunk
```

The plugin then **executes the manifest programmatically**: untouched nodes keep their original text, deleted nodes drop, `delete-text` fragments are removed by exact string match, rewritten nodes take the model's content, summarized ranges take the summary. Any malformed or uncertain manifest (prose, unknown ops, out-of-range seqs, overlaps, a split tool call/result pair, missing content) **falls back to a plain rewrite** of the chunk — the plugin never half-executes.

### When there is nothing to remove

A trim/compaction that finds nothing worth changing is a **normal outcome, not a failure**:

- **Per-chunk declaration (trim).** If the requirement changes nothing in a chunk, the model replies with exactly `<<NO_CHANGE>>` (or an empty manifest); the command layer keeps that chunk's **original rendering verbatim** in the checkpoint. A marker buried in other output is treated as content, not a declaration — a model that misuses the marker can only fail to shrink, never silently drop content.
- **Shrink validation.** If the assembled checkpoint is still not smaller than the span it replaces (e.g. every chunk declared no change), the command reports a no-change success — `Nothing to trim: …` / `Nothing to compact: …` — and leaves the conversation exactly as it was. It never loops, retries, or hangs. (This is why a directive like "delete all telemetry mentions" on a session with no telemetry returns with a message instead of churning for many minutes.)

### Where the command and its effect appear

- **Commands are log-only, not dialogue.** Like every dsh slash command (including upstream `/compact`), these commands do not appear as messages in the conversation UI. The invocation, result, and compaction lifecycle are visible in the **session trace/log**.
- **The original dialogue stays visible in the UI after a trim/compaction.** The conversation transcript never erases what you already saw (dsh's design; upstream `/compact` behaves the same). The **model** uses the checkpointed context on its next request — to verify the effect, read the session trace, not the chat transcript.

## Configuration

All fields are validated through the Cordis `Config` schema and settable from `cordis.yml`:

| Field | Default | Meaning |
|---|---|---|
| `keepHeadUsers` | `3` | User turns kept verbatim at the head (after the fixed skeleton) when planning the compact middle. |
| `keepTailUsers` | `3` | User turns kept verbatim at the tail; the last user utterance is always kept regardless. |
| `summarizationProvider` | `''` | Provider for the summarization call; falls back to the routed provider when empty. |
| `summarizationModel` | `''` | Model for the summarization call; falls back to the routed model when empty. |
| `maxTokens` | `8192` | Generation cap for the `/compact-directive` summarization call. |

## Known Limitations

- **A trim can take minutes.** The model reasons about your requirement before cutting (deliberately — disabling reasoning would hurt the cut decisions). A small conversation trims in about three minutes; a large one (~180K+ tokens, several parallel 50K chunks) can take 5–10+ minutes.
- **Model judgment is the trim's engine — and its limit.** The model decides what survives from the rendered dialogue. It generally follows the requirement, but it is *not* a deterministic per-node delete: a surgical instruction ("delete exactly this one message") can be interpreted as a broader compression, and an ambiguous requirement may yield an unexpected result. Check the session trace after a trim.
- **The injected skeleton is trim-able, and regenerates.** `/trim-directive` can remove the injected `agent-instructions` / `system-prompt` / `skill-catalog` nodes. They are re-created on the next request by the agent loop, so the model keeps its environment; nothing needs manual re-injection.
- **A trim whose total input exceeds 20 × 50K heuristic tokens fails loud** with "compact the session first" — before any model call opens. Compact the session first, then trim again.

## Further reading

- [docs/observability.md](docs/observability.md) — what each log line means, enabling debug output, diagnosing a slow or stalled run.
- [docs/model-experience.md](docs/model-experience.md) — what the model sees and the token / KV-cache effects of each command.
- [docs/testing.md](docs/testing.md) — running the test suites.

## License

MIT
