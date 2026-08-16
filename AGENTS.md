# AGENTS.md

`@ya8d/dsh-directive-compact` — a pure-incremental, directive-driven compaction plugin for DeepSeek Harness. It registers two global commands: `/compact-directive <requirement>` keeps a session's fixed skeleton head (first user message + injected agent-instructions / system-prompt / skill-catalog nodes) and recent turns verbatim while summarizing the middle span per the user's natural-language requirement; `/trim-directive <requirement>` hands the whole conversation to the model with a directive-only prompt and no region or system-node protection (the injected skeleton regenerates per request).

## Standing orders

- **Never touch `ctx.compaction`.** This package is purely additive: it does not inherit `BasicCompactionEngine`, does not register the `compaction` single slot, and registers no automatic-compaction listeners. The upstream backend and `/compact` command stay untouched.
- **Preserve the fixed skeleton head.** The head is the session's first user message and the injected nodes before the first `assistant/message` (the skeleton itself is the leading injected nodes before the first user; the first user message is the conversation anchor). Folding the head loses the environment knowledge the model works under. Any change that puts the head into the summarized span is a regression. `/trim-directive` deliberately has no head, tail, or system-node protection (that is its point; the injected skeleton regenerates per request, so removing it is safe — its trim range is the ENTIRE surface).
- **Document decisions.** Every non-trivial change carries an Agent Note under `.agents/notes/` (see [.agents/notes/README.md](.agents/notes/README.md)); the design rationale for the directive commands lives in the `implemented/architecture/` notes there.
- **Follow the harness test tiers.** Unit tests for pure logic, a REAL-composition test booting a cordis.yml through the Loader for the registered command, an HMR-safety test (dispose the fiber, assert unregister), and a with-key e2e that self-skips without a key. See [docs/testing.md](docs/testing.md).
- **Stay honest.** README `## Known Limitations` states what is not supported (for example, before/after rendering in the GUI); never silently omit a limit.
- **Function-plugin shape.** `src/index.ts` exports `name` / `inject` / `apply` and no default export — the Loader discards a function plugin's namespace when a default export is present.
- **ESM + strict.** `"type": "module"`, `strict`, `verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters`.

## Commands

```sh
npm run build       # tsc -p tsconfig.json → lib/
npm run typecheck   # tsc -p tsconfig.test.json (src + tests, noEmit)
npm run test        # vitest unit/REAL-composition/HMR
npm run test:e2e    # with-key e2e; self-skips without DEEPSEEK_API_KEY
```
