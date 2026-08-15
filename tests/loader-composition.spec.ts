import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as DirectiveCompact from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-directive-compact-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@ya8d/dsh-directive-compact', DirectiveCompact],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it('loads the plugin and registers both commands as global commands', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: '@ya8d/dsh-directive-compact'",
    ])
    // CommandRuntime exposes the registry; a global command is visible to any agent.
    const registry = loaded.commands
    expect(registry).toBeDefined()
    // The plugin's commands are registered (name present in the directory for a
    // minimal agent view; global definitions are plain-context registrations).
    const listed = registry.list(undefined as never)
    expect(listed.some(c => c.name === 'compact-directive')).toBe(true)
    expect(listed.some(c => c.name === 'trim-directive')).toBe(true)
  })

  it('exposes named exports only — no default export (Loader drops it otherwise)', async () => {
    const mod = await import('../src/index.ts')
    expect('default' in mod).toBe(false)
    expect(typeof mod.name).toBe('string')
    expect(Array.isArray(mod.inject)).toBe(true)
    expect(typeof mod.apply).toBe('function')
  })

  it('HMR-safety: disposing the fiber unregisters both commands', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: '@ya8d/dsh-directive-compact'",
    ])
    const registry = loaded.commands
    const names = (): string[] => registry.list(undefined as never).map(c => c.name)
    expect(names()).toContain('compact-directive')
    expect(names()).toContain('trim-directive')
    await loaded.fiber.dispose()
    expect(names()).not.toContain('compact-directive')
    expect(names()).not.toContain('trim-directive')
    context = undefined // already disposed; skip afterEach double-dispose
  })
})
