import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { executeDirectiveCompact } from '../src/command.js'
import type { CommandConfig } from '../src/command.js'

/**
 * With-key e2e: one real directive-driven compaction against the DeepSeek
 * public API. Self-skips without a key. The key resolves from
 * `$DEEPSEEK_API_KEY` when exported, otherwise from the Harness credentials
 * document at `$DSH_HOME/.credentials.yaml` (the web Models page writes it
 * there) — matching the launched product, not a test-only secret.
 */

/** Resolve the API key from the ambient environment, then the credentials document. */
function apiKey(): string | undefined {
  const ambient = process.env.DEEPSEEK_API_KEY
  if (ambient !== undefined && ambient.length > 0) return ambient
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  try {
    const yaml = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    const line = yaml.split(/\r?\n/).find(l => /^DEEPSEEK_API_KEY\s*:/.test(l))
    if (line === undefined) return undefined
    const value = line.slice(line.indexOf(':') + 1).trim()
    return value.length === 0 ? undefined : value
  } catch {
    return undefined
  }
}

const key = apiKey()

const CONFIG: CommandConfig = {
  keepHeadUsers: 3,
  keepTailUsers: 3,
  summarizationProvider: '',
  summarizationModel: '',
  maxTokens: 2048,
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllEnvs()
})

/** Append one full user turn (user message + assistant reply) to a session. */
function appendTurn(session: Session, turn: number, userText: string, assistantText: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: userText }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: assistantText }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Build a session with the fixed skeleton head plus N user turns. */
function sessionWithTurns(n: number): Session {
  const s = Session.create(SessionId('directive-e2e'))
  appendTurn(s, 1, 'first task', 'first answer')
  s.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'rules' }], source: { kind: 'plugin', plugin: 'agent-instructions' },
  }), { surfaceOp: 'append' })
  s.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'ctx' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
  }), { surfaceOp: 'append' })
  s.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'skills' }], source: { kind: 'plugin', plugin: 'skill-catalog' },
  }), { surfaceOp: 'append' })
  for (let i = 2; i <= n; i += 1) {
    appendTurn(s, i, `task ${i}`, `answer ${i}`)
  }
  return s
}

function agentFor(session: Session): Agent {
  return {
    session,
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  } as unknown as Agent
}

function invocationFor(agent: Agent, rawInput: string): CommandInvocation {
  return {
    commandId: 'e2e-1' as unknown as CommandId,
    agent,
    rawInput,
    signal: new AbortController().signal,
  }
}

describe.skipIf(key === undefined)('directive compaction with a real DeepSeek model', () => {
  it('summarizes the middle with the directive and replaces it', async () => {
    // describe.skipIf above guarantees the key; TS cannot narrow the module const.
    const apiKeyValue = key as string
    // The launched product resolves the key through the credential seam;
    // here the ambient variable stands in for that resolution so the real
    // LlmDeepSeek route can serve the request.
    vi.stubEnv('DEEPSEEK_API_KEY', apiKeyValue)

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(LlmDeepSeek, {})

    const s = sessionWithTurns(8)
    const surfaceBefore = s.surface.nodes.length
    const result = await executeDirectiveCompact(
      ctx,
      invocationFor(agentFor(s), 'keep the login details, drop the rest'),
      CONFIG,
    )
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    expect(result.text).toContain('per the directive')

    // Lifecycle appended: start, summary, user/message replace, end.
    const types = s.events.slice(-4).map(e => e.type)
    expect(types).toEqual(['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])

    // The summary event carries real provider facts and usage.
    const summaryEvent = s.events[s.events.length - 3]!
    const summaryData = summaryEvent.data as {
      provider: string
      model: string
      usage?: { inputTokens: number; outputTokens: number }
    }
    expect(summaryData.provider).toBe('deepseek-official')
    expect(summaryData.model).toBe('deepseek-v4-flash')
    expect(summaryData.usage?.inputTokens ?? 0).toBeGreaterThan(0)
    expect(summaryData.usage?.outputTokens ?? 0).toBeGreaterThan(0)

    // The middle span is gone from the surface, replaced by the checkpoint.
    expect(s.surface.nodes.length).toBeLessThan(surfaceBefore)
    const checkpoint = s.events[s.events.length - 2]!
    const source = (checkpoint.data as { source: { plugin?: string } }).source
    expect(source.plugin).toBe('compact')
    const summaryText = (summaryEvent.data as { summary: { type: string; text: string }[] }).summary
      .map(block => block.text)
      .join('\n')
    expect(summaryText.length).toBeGreaterThan(0)
  }, 120_000)
})
