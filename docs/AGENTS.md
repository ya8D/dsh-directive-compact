# AGENTS.md — This repository's documentation standard

This file defines how `@ya8d/dsh-directive-compact` documents itself. It follows the spirit of DeepSeek Harness's documentation standards (see the [deepseek-harness docs standard](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/AGENTS.md)) so that a harness maintainer reading this package finds familiar structure and honesty rules.

## Document structure

A fact has one home; elsewhere, link there.

| Tier | Job |
|---|---|
| `README.md` | The package contract: install, command usage, behavior, Known Limitations. |
| `.agents/notes/` | Active decision records: the why and what was given up. `implemented/` notes describe shipped reality in present tense. |
| `src/` JSDoc | Per-module and per-function contracts. |
| `tests/` | Behavioral pinning per `docs/testing.md` tiers (unit / REAL-composition / HMR-safety / with-key e2e). |

## Agent Notes

Every non-trivial change — one that alters behavior, a contract, the on-disk or wire format, or a decision a maintainer may revisit — adds or updates an Agent Note in the same change.

- Path: `.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`
- Lifecycles: `proposed/` (not yet built), `implemented/` (shipped), `rejected/`
- Classes: `feature`, `bug-fix`, `simplification`, `architecture`, `process`, `testing`
- Format: first three lines are `# Agent Note: <title>` + blank + `Status: <status>`; an implemented note opens `## Problem`, states `## Decision` in present tense, carries a mandatory `## Alternatives considered`, and closes with `## Consequences`. Proposal-era headings (`## Proposal`, `## Acceptance criteria`) are rejected in implemented notes.

## Writing rules

- State current reality, not change history: avoid "previously / now / no longer" in durable prose; put change stories in commits.
- Comments and JSDoc state complete contracts, not reasoning transcripts. Preserve behavior, failure, timing, ownership, and non-obvious orientation; delete narration.
- Be honest about limits: anything not supported (for example, before/after rendering in the GUI) lives under `## Known Limitations` in the README, never silently omitted.
- One physical line per paragraph; keep prose concise and direct.
