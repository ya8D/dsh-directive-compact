# @ya8d/dsh-directive-compact

A natural-language compaction plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It lets you tell the agent — in plain language — what to keep, what to drop, and how to compress an existing conversation.

Designed for large-context models (1M-token window, e.g. `deepseek-v4-flash`).

## Commands

| Command | What it does |
|---|---|
| `/compact-directive <requirement>` | Compresses the **middle** of the conversation. Keeps the session's fixed head (first user message + injected `agent-instructions` / `system-prompt` / `skill-catalog`) and the recent turns verbatim; summarizes everything between them per your requirement. |
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

The package declares `dsh.bundle`, so the plugin row is activated automatically and nothing from the upstream composition is disabled. Remove with `dsh plugin --profile <name> remove @ya8d/dsh-directive-compact` (or the matching `pnpm dsh ...` / `npx dsh ...` form).

This plugin is a **pure increment**: it never touches the upstream `ctx.compaction` slot, never registers automatic-compaction listeners, and leaves `/compact` exactly as it is.

### Extension points

- **Injected services**: `commands`, `sessions`, `llm`, `tokenMeter`.
- **Owned events**: the `compaction/start` / `compaction/summary` / `compaction/end` lifecycle, appended to the session log around every trim/compaction (see [Observability](#observability-where-a-trimcompaction-spends-its-time)).
- **Untouched upstream**: the `ctx.compaction` slot, the `/compact` command, and automatic-compaction listeners.

## Usage

Both requirements are plain free text **in any natural language**. Examples:

```
/compact-directive keep the login-related errors, compress the rest of the middle process
/trim-directive delete all git-operation records, keep the user's original instructions and the plugin-development goal
```

**`/compact-directive`** — the requirement is mandatory (an empty one returns a usage error).

**`/trim-directive`** — the requirement decides everything that survives.

### How the two differ

| | `/compact-directive` | `/trim-directive` |
|---|---|---|
| Region | Middle only; head + recent turns protected | **The whole surface; nothing protected** |
| Baseline | Requirement layered over a four-point summary baseline | Requirement is the sole instruction (no baseline) |
| Result | One checkpoint replacing the middle | One checkpoint replacing the whole surface |
| Use case | Routine context compression with a focus | Aggressive / surgical deletion the head-protected command cannot reach |

### Operation mode (how a trim actually cuts)

`/trim-directive` first runs every chunk in **operation mode**: the model sees the chunk as numbered nodes (`[seq 28039] [user] …`, reusing the harness's global event seq — the same numbering `session-query` uses) and replies with a small **operation manifest** instead of regenerating the whole context:

```
delete: 28039, 28045          remove whole nodes
delete-text: 28039, "..."     delete an exact fragment inside one node (zero generation)
rewrite: 28039                replace one node (partial edits) → its full new text
summarize: 28040-28045        replace a range with a short summary
---content--- … ---end---     (the replacement text for rewrite/summarize)
<<NO_CHANGE>>                 nothing to change in this chunk
```

The plugin then **executes the manifest programmatically**: untouched nodes splice into the checkpoint **verbatim** (zero generation — 100% fidelity, no drift, no hallucination), deleted nodes drop, `delete-text` fragments are removed by exact string match (also zero generation), rewritten nodes take the model's content, summarized ranges take the summary. Only the changed nodes spend time in the model — a trim that touches a few nodes of a large session no longer pays for regenerating the ~350K tokens that stay the same. Any malformed or uncertain manifest (prose, unknown ops, out-of-range seqs, overlaps, a split tool call/result pair, missing content) **falls back to the rewrite mode** below — the plugin never half-executes.

### When there is nothing to remove

A trim/compaction that finds nothing worth changing is a **normal outcome, not a failure**:

- **Per-chunk declaration (trim).** If the requirement changes nothing in a chunk, the model replies with exactly `<<NO_CHANGE>>` (or an empty manifest); the command layer keeps that chunk's **original rendering verbatim** in the checkpoint (the content must survive anyway, and paying the model to regenerate it is the entire wall-time cost). A marker buried in other output is treated as content, not a declaration — a model that misuses the marker can only fail to shrink, never silently drop content.
- **Shrink validation.** If the assembled checkpoint is still not smaller than the span it replaces (e.g. every chunk declared no change), the command reports a no-change success — `Nothing to trim: …` / `Nothing to compact: …` — records the output in the compaction lifecycle, and leaves the conversation exactly as it was. It never loops, retries, or hangs on a rewrite that cannot shrink. (This is why a directive like "delete all telemetry mentions" on a session with no telemetry returns with a message instead of churning for many minutes.)

### Where the command and its effect appear

- **Commands are log-only, not dialogue.** Like every dsh slash command (including upstream `/compact`), these commands do not appear as messages in the conversation UI. The invocation, result, and compaction lifecycle are visible in the **session trace/log**.
- **The original dialogue stays visible in the UI after a trim/compaction.** The conversation transcript never erases what you already saw (dsh's design; upstream `/compact` behaves the same). The **model** uses the checkpointed context on its next request — to verify the effect, read the session trace, not the chat transcript.

### Observability (where a trim/compaction spends its time)

Both commands log through the Cordis logger service under the `dsh-directive-compact` scope, so the dsh console shows a colored `[I] dsh-directive-compact …` line per phase:

- **Info** (visible at the default level): `begin` (directive, surface size, budget / chunk plan), per-chunk completion with elapsed ms and output tokens, `all N chunks done in …ms`, and `committed` (nodes/tokens replaced → checkpoint tokens, total ms). A failed run logs `failed — <reason> (<ms>)` at **warn**, as do per-chunk call retries (`chunk call failed, retrying (2/3): …`).
- **Debug** (hidden unless enabled): the summarization call's time-to-first-chunk and total stream time, and each chunk's seq range and token price. Enable with the console exporter's level for the plugin scope, e.g. in `cordis.yml`:

  ```yaml
  - id: logger-console
    name: '@deepseek-ai/cordis-plugin-logger-console'
    config:
      levels:
        dsh-directive-compact: 3   # 0 error, 1 info, 2 warn, 3 debug
  ```

  A long `first chunk in …` gap points at network/provider latency before generation; a long `chunk N/M done in …` points at the model's thinking time on that chunk; a stalled run with no `chunk … done` line after `begin` is a hung LLM call, not a plugin hang.

## Configuration

All fields are validated through the Cordis `Config` schema and settable from `cordis.yml`:

| Field | Default | Meaning |
|---|---|---|
| `keepHeadUsers` | `3` | User turns kept verbatim at the head (after the fixed skeleton) when planning the compact middle. |
| `keepTailUsers` | `3` | User turns kept verbatim at the tail; the last user utterance is always kept regardless. |
| `summarizationProvider` | `''` | Provider for the summarization call; falls back to the routed provider when empty. |
| `summarizationModel` | `''` | Model for the summarization call; falls back to the routed model when empty. |
| `maxTokens` | `8192` | Generation cap for the `/compact-directive` summarization call. |

## Development

```sh
npm test            # unit suite (no network/credentials)
npm run test:e2e    # real DeepSeek calls; self-skips without a key
npm run build       # tsc → lib/
```

## Model Experience

### `/compact-directive` summarization call

#### What the model sees

One user message with no system prompt, no tools, and no conversation prefix: the requirement (when given) layered over a four-point baseline (task goal / key steps done / key findings / next step), followed by the middle span rendered as role-prefixed plain text — `[user] …`, `[assistant] …`, `[tool] called tool …`, `[tool] tool result:`, `<image>` for images. The baseline requires every `[user]` line verbatim, and the rendering preserves it.

#### Token effect

Data-dependent: input ≈ the rendered middle span (bounded by the planner's keep-head/keep-tail defaults of 3 user turns each, and the 4M-character render guard); output ≤ the configured `maxTokens`.

#### KV Cache effect

An **independent model request**: a single fresh message with no conversation prefix, so it reuses no warm-prefix KV cache — the deliberate trade of cache reuse for a more focused summary, mirroring the upstream ContextForge calls. The call invalidates nothing in the session prefix.

### `/trim-directive` chunk calls (operation mode)

#### What the model sees

One user message per chunk, in parallel: the trim instruction (the requirement is the sole instruction — no four-point baseline) followed by the chunk rendered as numbered nodes — `[seq <global event seq>] [role] …`, continuation lines indented, reusing the harness's global event-seq vocabulary (`session-query` references events the same way). The instruction offers two forms: FORM 1, an operation manifest (one `delete:` / `delete-text:` / `rewrite:` / `summarize:` line per operation with `---content---` … `---end---` blocks, or exactly `<<NO_CHANGE>>` for an unchanged chunk); FORM 2, the chunk rewritten in full. Prose output is used as that chunk's rewrite; a parseable manifest that fails validation falls back to one rewrite-mode call with the unnumbered rendering.

#### Token effect

Input per chunk ≤ 50K heuristic tokens (max 20 chunks; total input beyond 20 × 50K fails loud before any call opens). Output ≤ `min(window/2, 256K)` per chunk; a chunk that declares `<<NO_CHANGE>>` costs ~0 output tokens and its original rendering is kept verbatim. A trim that touches a few nodes of a large session pays only for the changed chunks.

#### KV Cache effect

**Independent model requests**: every chunk is a single fresh message with no conversation prefix, so parallel chunk calls reuse no warm-prefix KV cache and invalidate nothing in the session prefix.

### The checkpoint (what replaces the trimmed span)

#### What the model sees

The checkpoint lands on the session surface as one user message: a marker naming the requirement (`[Directive-driven compaction checkpoint, per requirement: <requirement>]`, trim variant for `/trim-directive`), a guard stating that removed content is final and must not be reconstructed, and the summary text with `[part N/M]` dividers when chunked. On its next request, the model sees the checkpoint in place of the replaced nodes; the UI transcript keeps the original dialogue by dsh's design.

#### Token effect

Replacement: the shadowed span's tokens give way to the checkpoint's tokens; the shrink validation requires the checkpoint to be smaller than the span it replaces.

#### KV Cache effect

**Replacement of earlier request tokens**: the checkpoint becomes part of the session prefix for subsequent requests, which then resume append-only growth as the conversation continues. The summarization and trim calls themselves are independent requests (see above).

## Known Limitations and Deferred Work

- **No cross-chunk aggregate output cap.** Each chunk's output is capped at `min(window/2, 256K)`, but nothing caps the sum across chunks; the real bound is the shrink validation on the assembled checkpoint (it must be smaller than the span it replaces), so a model cannot "win" by filling every chunk. Input beyond the window fails loud. A transient failure on one chunk retries it (up to 3 attempts); cancellation is never retried.
- **Thinking is not disabled, so a trim can take tens of seconds to minutes — more on large conversations.** The model reasons about your requirement before writing the trimmed context (deliberately — disabling reasoning would hurt the cut decisions). Cost scales with the surface: a small conversation (~10K rendered tokens) trims in minutes; a large one (~180K+ tokens, several parallel 50K chunks) can take 5–10+ minutes. There is no live progress output yet (see the Deferred item below).
- **Model judgment is the trim's engine — and its limit.** The model decides what survives from the rendered dialogue. It generally follows the requirement, but it is *not* a deterministic per-node delete: a surgical instruction ("delete exactly this one message") can be interpreted as a broader compression, and an ambiguous requirement may yield an unexpected result. Check the session trace after a trim.
- **The injected skeleton is trim-able, and regenerates.** `/trim-directive` can remove the injected `agent-instructions` / `system-prompt` / `skill-catalog` nodes. They are re-created on the next request by the agent loop, so the model keeps its environment; nothing needs manual re-injection.
- **No before/after rendering in the UI.** The conversation transcript never erases what you already saw (see [Where the command and its effect appear](#where-the-command-and-its-effect-appear)); to see the trim's effect, read the session trace.
- **Deferred: live progress feedback.** Phase milestones are logged only; a "compressing chunk N/M" progress line in the console is not implemented yet.
- **Deferred: conservative shrink-failure path.** When the assembled checkpoint does not shrink, the command reports no-change and keeps the surface whole; a future path could execute the safe subset (deletes / summarizes / delete-text, with inflated rewrites kept verbatim) instead of giving up wholesale.
- **Deferred: UI compaction card for non-`compact` command names.** Rendering a replacement card for `/compact-directive` / `/trim-directive` in the conversation UI is an upstream `ui-conversation` change, outside this plugin; until then the trim/compaction effect is visible in the session trace only.
- **Deferred: safety-refusal probe.** A with-key e2e probing how DeepSeek handles aggressively negative directives (e.g. "delete everything") is not yet in the suite.

## License

MIT
