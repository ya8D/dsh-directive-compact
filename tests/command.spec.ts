import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { executeDirectiveCompact, resolveDirectiveTarget, surfaceNodes, DirectiveCompactionError } from '../src/command.js'
import type { CommandConfig } from '../src/command.js'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'

const CONFIG: CommandConfig = {
  keepHeadUsers: 3,
  keepTailUsers: 3,
  summarizationProvider: '',
  summarizationModel: '',
  maxTokens: 4096,
}

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
  const s = Session.create(SessionId('cmd-test'))
  appendTurn(s, 1, 'first task', 'first answer')
  // The skeleton injections follow the first user message in a real session;
  // emulate them as injected nodes after turn 1.
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

/** A minimal agent over a session. */
function agentFor(session: Session): Agent {
  return {
    session,
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  } as unknown as Agent
}

function invocationFor(agent: Agent, rawInput: string): CommandInvocation {
  return {
    commandId: 'cmd-1' as unknown as CommandId,
    agent,
    rawInput,
    signal: new AbortController().signal,
  }
}

/** A fake context whose `llm.stream` yields the given chunks. */
function fakeCtx(chunks: readonly StreamChunk[]): Pick<Context, 'llm' | 'tokenMeter'> {
  return {
    llm: {
      async *stream(): AsyncIterable<StreamChunk> {
        for (const chunk of chunks) yield chunk
      },
    } as unknown as Context['llm'],
    tokenMeter: {
      estimateMessage: () => 10,
    } as unknown as Context['tokenMeter'],
  } as unknown as Pick<Context, 'llm' | 'tokenMeter'>
}

const SUMMARY_CHUNKS: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk,
  { type: 'text-delta', index: 0, text: 'summarized middle' } as StreamChunk,
  { type: 'block-end', index: 0, block: { type: 'text', text: 'summarized middle' } } as StreamChunk,
  { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
]

describe('surfaceNodes', () => {
  it('builds node descriptors with the right source kinds', () => {
    const s = sessionWithTurns(4)
    const nodes = surfaceNodes(s)
    expect(nodes[0]!.kind).toBe('user') // first user message
    expect(nodes.some(n => n.kind === 'agent-instructions')).toBe(true)
    expect(nodes.some(n => n.kind === 'skill-catalog')).toBe(true)
    expect(nodes.every(n => n.type === 'user/message' || n.type === 'assistant/message')).toBe(true)
  })
})

describe('resolveDirectiveTarget', () => {
  it('falls back to AgentOptions when no route and no configured pair', () => {
    const s = sessionWithTurns(4)
    const target = resolveDirectiveTarget(agentFor(s), CONFIG)
    expect(target.provider).toBe('deepseek-official')
    expect(target.model).toBe('deepseek-v4-flash')
    expect(target.maxTokens).toBe(4096)
  })
  it('prefers the configured pair over AgentOptions', () => {
    const s = sessionWithTurns(4)
    const config: CommandConfig = { ...CONFIG, summarizationProvider: 'local', summarizationModel: 'small' }
    const target = resolveDirectiveTarget(agentFor(s), config)
    expect(target.provider).toBe('local')
    expect(target.model).toBe('small')
  })
})

describe('executeDirectiveCompact', () => {
  it('returns none for a short session', async () => {
    const s = sessionWithTurns(3)
    const result = await executeDirectiveCompact(fakeCtx([]) as never, invocationFor(agentFor(s), 'keep x'), CONFIG)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('No compactable')
  })

  it('compacts the middle and records the lifecycle', async () => {
    const s = sessionWithTurns(8)
    const before = s.events.length
    const result = await executeDirectiveCompact(
      fakeCtx(SUMMARY_CHUNKS) as never,
      invocationFor(agentFor(s), 'keep login'),
      CONFIG,
    )
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    expect(result.text).toContain('per the directive')
    // Lifecycle appended: start, summary, user/message replace, end = 4 events.
    expect(s.events.length).toBe(before + 4)
    const types = s.events.slice(before).map(e => e.type)
    expect(types[0]).toBe('compaction/start')
    expect(types[1]).toBe('compaction/summary')
    expect(types[2]).toBe('user/message')
    expect(types[3]).toBe('compaction/end')
    // The replacement shadows a middle range.
    const replace = s.events[before + 2]!
    const surfaceOp = (replace as { surfaceOp?: { op: string; start: number; end: number } }).surfaceOp!
    expect(surfaceOp.op).toBe('replace')
    expect(surfaceOp.start).toBeLessThan(surfaceOp.end)
    // The checkpoint message source is a compact checkpoint.
    const source = (replace.data as { source: { plugin?: string } }).source
    expect(source.plugin).toBe('compact')
  })

  it('closes the lifecycle with an error on summarization failure', async () => {
    const s = sessionWithTurns(8)
    const ctx = fakeCtx([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'E' } } } as StreamChunk,
    ])
    await expect(executeDirectiveCompact(ctx as never, invocationFor(agentFor(s), 'keep x'), CONFIG))
      .rejects.toThrow(DirectiveCompactionError)
    const last = s.events[s.events.length - 1]!
    expect(last.type).toBe('compaction/end')
    expect((last.data as { error?: string }).error).toContain('boom')
  })

  it('refuses standalone compaction while a turn is open (busy)', async () => {
    const s = sessionWithTurns(8)
    // Open a turn without closing it (turn numbering is contiguous from the fixture).
    s.append('turn/start', { turn: 9 })
    await expect(executeDirectiveCompact(fakeCtx(SUMMARY_CHUNKS) as never, invocationFor(agentFor(s), 'keep x'), CONFIG))
      .rejects.toThrow(DirectiveCompactionError)
    // No compaction events were appended.
    expect(s.events.some(e => e.type === 'compaction/start')).toBe(false)
  })

  it('tolerates an empty-content node in the middle span', async () => {
    const s = sessionWithTurns(8)
    // Inject an empty-content user/message (e.g. a feedback node) mid-session.
    s.append('user/message', createUserMessage({
      content: [], source: { kind: 'plugin', plugin: 'feedback' },
    }), { surfaceOp: 'append' })
    const result = await executeDirectiveCompact(
      fakeCtx(SUMMARY_CHUNKS) as never,
      invocationFor(agentFor(s), 'keep x'),
      CONFIG,
    )
    expect(result.kind).toBe('success')
  })
})
