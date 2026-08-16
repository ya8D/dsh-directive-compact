# Observability

Both commands log through the Cordis logger service under the `dsh-directive-compact` scope, so the dsh console shows a colored `[I] dsh-directive-compact …` line per phase.

## Log lines

- **Info** (visible at the default level): `begin` (directive, surface size, budget / chunk plan), per-chunk completion with elapsed ms and output tokens, `all N chunks done in …ms`, and `committed` (nodes/tokens replaced → checkpoint tokens, total ms). A failed run logs `failed — <reason> (<ms>)` at **warn**, as do per-chunk call retries (`chunk call failed, retrying (2/3): …`).
- **Debug** (hidden unless enabled): the summarization call's time-to-first-chunk and total stream time, and each chunk's seq range and token price.

## Enabling debug

Set the console exporter's level for the plugin scope, e.g. in `cordis.yml`:

```yaml
- id: logger-console
  name: '@deepseek-ai/cordis-plugin-logger-console'
  config:
    levels:
      dsh-directive-compact: 3   # 0 error, 1 info, 2 warn, 3 debug
```

## Diagnosing a slow or stalled run

A long `first chunk in …` gap points at network/provider latency before generation; a long `chunk N/M done in …` points at the model's thinking time on that chunk; a stalled run with no `chunk … done` line after `begin` is a hung LLM call, not a plugin hang.
