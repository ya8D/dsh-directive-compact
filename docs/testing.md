# Testing

`@ya8d/dsh-directive-compact` follows DeepSeek Harness's testing tiers, scaled to a single-package repo. Tests live with the code they exercise.

## Tiers

| Tier | Where | Requires |
|---|---|---|
| Unit | `tests/**/*.spec.ts` — pure logic (planning, trim budget/chunking, prompt building) | Nothing |
| Command transaction | `tests/command.spec.ts`, `tests/trim.spec.ts` — real `Session` + fake LLM stream | Nothing |
| REAL-composition | `tests/loader-composition.spec.ts` — Loader boots a cordis.yml, command registered; no-default-export assertion; HMR-safety (dispose → unregister) | Nothing |
| With-key e2e | `tests/directive-compact.e2e.ts` — real DeepSeek API | `$DEEPSEEK_API_KEY` or `$DSH_HOME/.credentials.yaml`; self-skips without one |

## Commands

```sh
npm test            # unit + command + REAL-composition + HMR (no network)
npm run test:e2e    # with-key e2e; collected only here, self-skips without a key
npm run typecheck   # tsc -p tsconfig.test.json (src + tests)
npm run build       # tsc -p tsconfig.json (src → lib/)
```

The e2e file is collected only by `test:e2e` (`vitest.e2e.config.ts` includes `tests/**/*.e2e.ts`); `npm test` (`vitest.config.ts` includes `tests/**/*.spec.ts`) never loads it, so the default suite needs no network or credentials.
