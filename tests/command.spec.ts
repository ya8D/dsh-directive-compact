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
import { createLoggerStub } from './helpers.js'

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
function fakeCtx(chunks: readonly StreamChunk[], logger?: Context['logger']): Pick<Context, 'llm' | 'tokenMeter' | 'logger'> {
  return {
    llm: {
      async *stream(): AsyncIterable<StreamChunk> {
        for (const chunk of chunks) yield chunk
      },
    } as unknown as Context['llm'],
    tokenMeter: {
      estimateMessage: () => 10,
    } as unknown as Context['tokenMeter'],
    logger: logger ?? createLoggerStub().logger,
  } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
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

  it('regression: a cancelled summarization leaves the surface intact', async () => {
    const s = sessionWithTurns(8)
    const surfaceBefore = [...s.surface.nodes]
    // A stream that throws a cancellation error.
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          throw new Error('This operation was aborted')
        },
      },
      tokenMeter: { estimateMessage: () => 10 },
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    await expect(executeDirectiveCompact(ctx as never, invocationFor(agentFor(s), 'keep x'), CONFIG))
      .rejects.toThrow()
    // Lifecycle closed with an error, but no surface replacement was made.
    expect(s.events[s.events.length - 1]!.type).toBe('compaction/end')
    expect(s.surface.nodes).toEqual(surfaceBefore)
  })

  it('regression: a failed compaction never leaves a partial replace', async () => {
    const s = sessionWithTurns(8)
    const surfaceBefore = [...s.surface.nodes]
    const ctx = fakeCtx([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'E' } } } as StreamChunk,
    ])
    await expect(executeDirectiveCompact(ctx as never, invocationFor(agentFor(s), 'keep x'), CONFIG))
      .rejects.toThrow(DirectiveCompactionError)
    // No user/message replace was appended; the surface is unchanged.
    expect(s.surface.nodes).toEqual(surfaceBefore)
    // From the compaction/start marker on, only the lifecycle events exist —
    // no user/message replacement landed.
    const startIdx = s.events.findIndex(e => e.type === 'compaction/start')
    const after = s.events.slice(startIdx)
    expect(after.map(e => e.type)).toEqual(['compaction/start', 'compaction/end'])
  })

  it('P7: rejects an empty directive and points at /compact', async () => {
    const s = sessionWithTurns(8)
    const before = s.events.length
    const result = await executeDirectiveCompact(fakeCtx(SUMMARY_CHUNKS) as never, invocationFor(agentFor(s), '   '), CONFIG)
    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.text).toContain('/compact-directive <requirement>')
    expect(result.text).toContain('/compact')
    // No lifecycle was opened: the refusal happens before compaction/start.
    expect(s.events.length).toBe(before)
  })

  it('treats an unshrunk checkpoint as a no-change success (nothing to compact)', async () => {
    const s = sessionWithTurns(8)
    const userMessagesBefore = s.events.filter(e => e.type === 'user/message').length
    const ctx = fakeCtx(SUMMARY_CHUNKS)
    // Distinguish the framed checkpoint from the shadowed nodes by content:
    // the checkpoint carries the directive marker + guard, the shadowed
    // conversation messages do not. This survives estimateMessage call-count
    // changes, unlike a positional "first N calls are shadowed" threshold.
    const inflated = {
      llm: ctx.llm,
      tokenMeter: {
        estimateMessage: (message: { content: { type: string; text: string }[] }) => {
          const text = message.content.map(b => b.text).join('')
          return text.includes('[Directive-driven compaction checkpoint') ? 1000 : 10
        },
      },
      logger: ctx.logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    const result = await executeDirectiveCompact(inflated as never, invocationFor(agentFor(s), 'keep x'), CONFIG)
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    expect(result.text).toContain('Nothing to compact')
    // Lifecycle start → summary → end with NO user/message replace; the
    // surface is untouched and the end is a success (no error).
    const startIdx = s.events.findIndex(e => e.type === 'compaction/start')
    const after = s.events.slice(startIdx).map(e => e.type)
    expect(after).toEqual(['compaction/start', 'compaction/summary', 'compaction/end'])
    expect(s.events.filter(e => e.type === 'user/message').length).toBe(userMessagesBefore)
    expect((s.events[s.events.length - 1]!.data as { error?: string }).error).toBeUndefined()
  })

  it('logs phase milestones with timings on success', async () => {
    const s = sessionWithTurns(8)
    const stub = createLoggerStub()
    const result = await executeDirectiveCompact(
      fakeCtx(SUMMARY_CHUNKS, stub.logger) as never,
      invocationFor(agentFor(s), 'keep the login flow'),
      CONFIG,
    )
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    const info = stub.records.filter(r => r.level === 'info').map(r => r.args.join(' '))
    // Begin names the directive (truncated), the surface, and the plan.
    const begin = info.find(m => m.includes('compact-directive: begin'))
    expect(begin).toBeDefined()
    expect(begin).toContain('keep the login flow')
    expect(begin).toContain('surface')
    expect(begin).toContain('middle')
    // Summarization and commit report durations.
    expect(info.some(m => m.includes('compact-directive: summarization done in') && m.includes('ms'))).toBe(true)
    expect(info.some(m => m.includes('compact-directive: committed') && m.includes('ms total'))).toBe(true)
  })

  it('logs a warning with the failure reason and duration', async () => {
    const s = sessionWithTurns(8)
    const stub = createLoggerStub()
    await expect(executeDirectiveCompact(
      fakeCtx([
        { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'E' } } } as StreamChunk,
      ], stub.logger) as never,
      invocationFor(agentFor(s), 'keep x'),
      CONFIG,
    )).rejects.toThrow(DirectiveCompactionError)
    const warns = stub.records.filter(r => r.level === 'warn').map(r => r.args.join(' '))
    expect(warns.some(m => m.includes('compact-directive: failed') && m.includes('boom'))).toBe(true)
  })
})
