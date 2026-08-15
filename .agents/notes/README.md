# Agent Notes

One kind of design doc lives here. An **Agent Note** records a decision or proposal that affects this package — the *why* and *what we gave up*, the parts code and README cannot carry. The format follows DeepSeek Harness's [Agent Note rules](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/README.md).

## Layout and naming

`{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`:

- **Lifecycle**: `proposed/` (not built), `implemented/` (shipped, kept current with what shipped), `rejected/`.
- **Class**: `feature` / `bug-fix` / `simplification` / `architecture` / `process` / `testing`.

## When to write one

Every non-trivial change adds or updates at least one Agent Note in the same change. A change is non-trivial when it alters behavior, a contract, a format, process, testing strategy, or a decision a maintainer may reasonably revisit. A purely mechanical edit is exempt.

## The file format

```
# Agent Note: <title>

Status: <status>
```

An `implemented/` note opens with `## Problem`, states the decision under `## Decision` in present tense, carries a mandatory `## Alternatives considered` (each genuine alternative and why it lost), and closes with `## Consequences` (what the trade-off cost and bought). Proposal-era headings are rejected in implemented notes.

Updating the note that already owns a decision satisfies the rule; do not create duplicates. Never edit a note into a different decision — supersede it with a new note and cross-link.
