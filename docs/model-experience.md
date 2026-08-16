# Model Experience

What the plugin's commands put into model requests, in the [DeepSeek Harness package-README format](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-package.md#4-write-the-package-readme). The package README links here; this document is the full contract.

## `/compact-directive` summarization call

### What the model sees

One user message with no system prompt, no tools, and no conversation prefix: the requirement (when given) layered over a four-point baseline (task goal / key steps done / key findings / next step), followed by the middle span rendered as role-prefixed plain text — `[user] …`, `[assistant] …`, `[tool] called tool …`, `[tool] tool result:`, `<image>` for images. The baseline requires every `[user]` line verbatim, and the rendering preserves it.

### Token effect

Data-dependent: input ≈ the rendered middle span (bounded by the planner's keep-head/keep-tail defaults of 3 user turns each, and the 4M-character render guard); output ≤ the configured `maxTokens`.

### KV Cache effect

An **independent model request**: a single fresh message with no conversation prefix, so it reuses no warm-prefix KV cache — the deliberate trade of cache reuse for a more focused summary, mirroring the upstream ContextForge calls. The call invalidates nothing in the session prefix.

## `/trim-directive` chunk calls (operation mode)

### What the model sees

One user message per chunk, in parallel: the trim instruction (the requirement is the sole instruction — no four-point baseline) followed by the chunk rendered as numbered nodes — `[seq <global event seq>] [role] …`, continuation lines indented, reusing the harness's global event-seq vocabulary (`session-query` references events the same way). The model replies with an operation manifest (`delete:` / `delete-text:` / `rewrite:` / `summarize:` lines, `---content---` … `---end---` content blocks for rewrite/summarize, or exactly `<<NO_CHANGE>>` for an unchanged chunk) or the chunk rewritten in full; the command layer executes either (see the README's [Operation mode](../README.md#operation-mode-how-a-trim-actually-cuts)).

### Token effect

Input per chunk ≤ 50K heuristic tokens (max 20 chunks; total input beyond 20 × 50K fails loud before any call opens). Output ≤ `min(window/2, 256K)` per chunk; a chunk that declares `<<NO_CHANGE>>` costs ~0 output tokens and its original rendering is kept verbatim. A trim that touches a few nodes of a large session pays only for the changed chunks.

### KV Cache effect

**Independent model requests**: every chunk is a single fresh message with no conversation prefix, so parallel chunk calls reuse no warm-prefix KV cache and invalidate nothing in the session prefix.

## The checkpoint (what replaces the trimmed span)

### What the model sees

The checkpoint lands on the session surface as one user message: a marker naming the requirement (`[Directive-driven compaction checkpoint, per requirement: <requirement>]`, trim variant for `/trim-directive`), a guard stating that removed content is final and must not be reconstructed, and the summary text with `[part N/M]` dividers when chunked. On its next request, the model sees the checkpoint in place of the replaced nodes; the UI transcript keeps the original dialogue by dsh's design.

### Token effect

Replacement: the shadowed span's tokens give way to the checkpoint's tokens; the shrink validation requires the checkpoint to be smaller than the span it replaces.

### KV Cache effect

**Replacement of earlier request tokens**: the checkpoint becomes part of the session prefix for subsequent requests, which then resume append-only growth as the conversation continues. The summarization and trim calls themselves are independent requests (see above).
