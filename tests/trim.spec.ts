import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { CallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { buildTrimPrompt, TRIM_INSTRUCTION, TRIM_NO_CHANGE_MARKER, trimMarker, chunkTrimNodes, resolveTrimBudget } from '../src/trim.js'
import { createLoggerStub } from './helpers.js'
import { executeTrim } from '../src/command-trim.js'
import { DirectiveCompactionError } from '../src/command.js'

describe('resolveTrimBudget', () => {
  it('caps output at the 256K adapter cap on the 1M target and chunks at a fixed 50K with 20 chunks', () => {
    // Only the 1M-window / 256K-cap target is supported; the adapter is always
    // the min (256K < 500K = window/2), so the window branch of the min is
    // deliberately not exercised.
    const budget = resolveTrimBudget(1_000_000, 256_000)
    expect(budget.maxTokens).toBe(256_000)
    expect(budget.chunkInputBudget).toBe(50_000) // fixed; targets the 1M window
    expect(budget.maxChunks).toBe(20) // 20 × 50K = 1M
  })
  it('rejects invalid window or adapter cap', () => {
    expect(() => resolveTrimBudget(0, 256_000)).toThrow(/invalid context window/)
    expect(() => resolveTrimBudget(1_000_000, 0)).toThrow(/invalid adapter max tokens/)
  })
})

describe('chunkTrimNodes', () => {
  const budget = resolveTrimBudget(1_000_000, 256_000)

  it('returns one chunk when total fits the budget', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => ({ seq: i, tokens: 100 }))
    const chunks = chunkTrimNodes(nodes, budget, () => true)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('splits into multiple chunks when the total exceeds one chunk budget', () => {
    // 6 nodes × 15K = 90K > 50K chunk budget → 2 chunks of 45K.
    const nodes = Array.from({ length: 6 }, (_, i) => ({ seq: i, tokens: 15_000 }))
    const chunks = chunkTrimNodes(nodes, budget, () => true)
    expect(chunks.length).toBe(2)
    expect(chunks[0]!.seqs).toEqual([0, 1, 2]) // 45K
    expect(chunks[1]!.seqs).toEqual([3, 4, 5]) // 45K
  })

  it('rolls a cut back to a balanced boundary', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => ({ seq: i, tokens: 15_000 }))
    // Accumulation crosses the 50K budget at node 3 (15K×3=45K < 50K,
    // 15K×4=60K ≥ 50K at node 3). The cut BEFORE node 3 is "unbalanced" (a
    // tool pair spans it), so it rolls back to before node 2, whose cut is
    // balanced — the chunk ends before node 2.
    const chunks = chunkTrimNodes(nodes, budget, node => node.seq !== 3)
    expect(chunks[0]!.seqs).toEqual([0, 1])
    expect(chunks[1]!.seqs).toEqual([2, 3, 4])
    expect(chunks[2]!.seqs).toEqual([5])
  })

  it('takes an oversized single node whole rather than looping forever', () => {
    const nodes = [
      { seq: 0, tokens: 60_000 }, // alone exceeds the 50K chunk budget
      { seq: 1, tokens: 100 },
    ]
    const chunks = chunkTrimNodes(nodes, budget, () => false)
    expect(chunks[0]!.seqs).toEqual([0])
    expect(chunks[1]!.seqs).toEqual([1])
  })

  it('fails loud when total input exceeds the chunk-count bound', () => {
    // 9 nodes × 300K = 2.7M > 20 × 50K = 1M.
    const nodes = Array.from({ length: 9 }, (_, i) => ({ seq: i, tokens: 300_000 }))
    expect(() => chunkTrimNodes(nodes, budget, () => true)).toThrow(/compact the session first/)
  })

  it('returns empty for no nodes', () => {
    expect(chunkTrimNodes([], budget, () => true)).toEqual([])
  })
})

describe('buildTrimPrompt', () => {
  it('embeds the requirement verbatim, directive-only (no four-point baseline)', () => {
    const prompt = buildTrimPrompt('delete everything about doc, keep the login flow')
    expect(prompt).toContain(TRIM_INSTRUCTION)
    expect(prompt).toContain('delete everything about doc, keep the login flow')
    expect(prompt).not.toContain('task goal')
    expect(prompt).not.toContain('next step')
  })
  it('fails loud on an empty requirement', () => {
    expect(() => buildTrimPrompt('')).toThrow(/non-empty requirement/)
    expect(() => buildTrimPrompt(undefined)).toThrow(/non-empty requirement/)
  })
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
  const s = Session.create(SessionId('trim-test'))
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

function agentFor(session: Session): Agent {
  return {
    session,
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  } as unknown as Agent
}

function invocationFor(agent: Agent, rawInput: string, signal: AbortSignal = new AbortController().signal): CommandInvocation {
  return {
    commandId: 'trim-1' as unknown as CommandId,
    agent,
    rawInput,
    signal,
  }
}

/** A fake context whose `llm.stream` yields the given chunks. */
function fakeCtx(chunks: readonly StreamChunk[], logger?: Context['logger']): Pick<Context, 'llm' | 'tokenMeter' | 'logger'> {
  return {
    llm: {
      async *stream(): AsyncIterable<StreamChunk> {
        for (const chunk of chunks) yield chunk
      },
      async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
        return { context: { contextWindow: 1_000_000 } }
      },
    } as unknown as Context['llm'],
    tokenMeter: meterWith(() => 10),
    logger: logger ?? createLoggerStub().logger,
  } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
}

/** A token meter whose per-message estimate is `estimate`, with measure support. */
function meterWith(estimate: (message: { content: { type: string; text: string }[] }) => number): Context['tokenMeter'] {
  return {
    estimateMessage: estimate,
    measure: (session: Session) => {
      const nodes = session.surface.nodes.map(seq => ({ seq, tokens: 10 }))
      return { nodes, totalTokens: nodes.length * 10, surfaceTokens: nodes.length * 10 }
    },
  } as unknown as Context['tokenMeter']
}

/** Fake LLM output that shrinks the context: 2 text blocks. */
const TRIM_CHUNKS: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk,
  { type: 'text-delta', index: 0, text: 'trimmed context' } as StreamChunk,
  { type: 'block-end', index: 0, block: { type: 'text', text: 'trimmed context' } } as StreamChunk,
  { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
]

/** Rendered text of the live surface (the model-visible view, not the log). */
function surfaceText(session: Session): string {
  return session.surface.nodes.map(seq => {
    const message = session.deriveEventMessage(session.events[seq]!)
    if (message === null) return ''
    return message.content.map(block => block.type === 'text' ? block.text : '').join('')
  }).join('\n')
}

describe('executeTrim', () => {
  it('errors on an empty directive', async () => {
    const s = sessionWithTurns(5)
    const result = await executeTrim(fakeCtx(TRIM_CHUNKS) as never, invocationFor(agentFor(s), '   '))
    expect(result.kind).toBe('error')
  })

  it('returns success with no changes on a completely empty surface', async () => {
    const s = Session.create(SessionId('trim-empty'))
    const result = await executeTrim(fakeCtx(TRIM_CHUNKS) as never, invocationFor(agentFor(s), 'drop all'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    expect(result.text).toContain('No conversational content')
  })

  it('trims the whole conversational range and records the lifecycle', async () => {
    const s = sessionWithTurns(8)
    const before = s.events.length
    const result = await executeTrim(fakeCtx(TRIM_CHUNKS) as never, invocationFor(agentFor(s), 'keep login only'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    expect(result.text).toContain('per the requirement')
    // Lifecycle appended: start, summary, user/message replace, end = 4 events.
    const types = s.events.slice(before).map(e => e.type)
    expect(types).toEqual(['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
    // The replacement shadows a wide conversational range.
    const replace = s.events[before + 2]!
    const surfaceOp = (replace as { surfaceOp?: { op: string; start: number; end: number } }).surfaceOp!
    expect(surfaceOp.op).toBe('replace')
    // The checkpoint source is a compact checkpoint.
    const source = (replace.data as { source: { plugin?: string } }).source
    expect(source.plugin).toBe('compact')
  })

  it('P10 full-freedom: the whole surface is in the trim range, including the injected skeleton', async () => {
    const s = sessionWithTurns(5)
    const result = await executeTrim(fakeCtx(TRIM_CHUNKS) as never, invocationFor(agentFor(s), 'drop all dialogue'))
    expect(result.kind).toBe('success')
    // The injected skeleton is NOT preserved: the whole surface was shadowed
    // and replaced by the checkpoint (system nodes regenerate per request).
    const text = surfaceText(s)
    expect(text).not.toContain('rules')
    expect(text).not.toContain('ctx')
    expect(text).not.toContain('skills')
    expect(text).toContain(trimMarker('drop all dialogue'))
  })

  it('passes the directive verbatim to the LLM prompt', async () => {
    let seenPrompt = ''
    const s = sessionWithTurns(5)
    const ctx = {
      llm: {
        async *stream(options: { messages: { content: { type: string; text: string }[] }[] }): AsyncIterable<StreamChunk> {
          const text = options.messages[0]?.content[0]?.text ?? ''
          seenPrompt = text
          yield TRIM_CHUNKS[0]!
          yield TRIM_CHUNKS[1]!
          yield TRIM_CHUNKS[2]!
          yield TRIM_CHUNKS[3]!
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: meterWith(() => 10),
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    await executeTrim(ctx as never, invocationFor(agentFor(s), '删除所有和 doc 相关的内容'))
    expect(seenPrompt).toContain('删除所有和 doc 相关的内容')
    // P10 full-freedom: the injected skeleton IS rendered (whole surface goes
    // to the model; the nodes regenerate per request anyway).
    expect(seenPrompt).toContain('rules')
    expect(seenPrompt).toContain('skills')
  })

  it('refuses standalone trim while a turn is open (busy)', async () => {
    const s = sessionWithTurns(5)
    s.append('turn/start', { turn: 9 })
    await expect(executeTrim(fakeCtx(TRIM_CHUNKS) as never, invocationFor(agentFor(s), 'drop all')))
      .rejects.toThrow(DirectiveCompactionError)
    expect(s.events.some(e => e.type === 'compaction/start')).toBe(false)
  })

  it('treats an unshrunk checkpoint as a no-change success (nothing to trim)', async () => {
    const s = sessionWithTurns(5)
    const surfaceBefore = [...s.surface.nodes]
    const ctx = fakeCtx(TRIM_CHUNKS)
    // Distinguish the framed checkpoint from the shadowed nodes by content:
    // the checkpoint carries the trim marker + guard, the shadowed
    // conversation messages do not. Survives estimateMessage call-count
    // changes, unlike a positional "first N calls are shadowed" threshold.
    const inflated = {
      llm: ctx.llm,
      tokenMeter: meterWith((message: { content: { type: string; text: string }[] }) => {
        const text = message.content.map(b => b.text).join('')
        return text.includes('[Directive trim, per requirement') ? 1000 : 10
      }),
      logger: ctx.logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    const result = await executeTrim(inflated as never, invocationFor(agentFor(s), 'drop all'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    expect(result.text).toContain('Nothing to trim')
    // Lifecycle start → summary → end with NO user/message replace; the
    // surface is untouched and the end is a success (no error).
    const startIdx = s.events.findIndex(e => e.type === 'compaction/start')
    const after = s.events.slice(startIdx).map(e => e.type)
    expect(after).toEqual(['compaction/start', 'compaction/summary', 'compaction/end'])
    expect(s.surface.nodes).toEqual(surfaceBefore)
    expect((s.events[s.events.length - 1]!.data as { error?: string }).error).toBeUndefined()
  })

  it('closes the lifecycle with an error on summarization failure', async () => {
    const s = sessionWithTurns(5)
    const ctx = fakeCtx([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'E' } } } as StreamChunk,
    ])
    await expect(executeTrim(ctx as never, invocationFor(agentFor(s), 'drop all')))
      .rejects.toThrow(DirectiveCompactionError)
    const last = s.events[s.events.length - 1]!
    expect(last.type).toBe('compaction/end')
    expect((last.data as { error?: string }).error).toContain('boom')
  })

  it('P8 review: fails loud when the model reports no context window', async () => {
    const s = sessionWithTurns(5)
    const before = s.events.length
    const ctx = {
      llm: {
        async resolveModelInfo(): Promise<{ context?: never }> {
          return {} // no contextWindow — must not silently assume 1M
        },
      },
      tokenMeter: meterWith(() => 10),
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    await expect(executeTrim(ctx as never, invocationFor(agentFor(s), 'drop all')))
      .rejects.toThrow(/no context window/)
    // The refusal happens before compaction/start opens.
    expect(s.events.length).toBe(before)
  })

  it('regression: a cancelled trim leaves the surface intact', async () => {
    const s = sessionWithTurns(5)
    const surfaceBefore = [...s.surface.nodes]
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          throw new Error('This operation was aborted')
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: meterWith(() => 10),
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    await expect(executeTrim(ctx as never, invocationFor(agentFor(s), 'drop all')))
      .rejects.toThrow()
    expect(s.events[s.events.length - 1]!.type).toBe('compaction/end')
    expect(s.surface.nodes).toEqual(surfaceBefore)
  })

  it('P8 retry: a transient chunk failure retries and succeeds', async () => {
    const s = sessionWithTurns(5)
    const before = s.events.length
    // First stream call fails (transient network), the retry succeeds.
    let streamCalls = 0
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          streamCalls += 1
          if (streamCalls === 1) throw new Error('network hiccup')
          yield TRIM_CHUNKS[0]!
          yield TRIM_CHUNKS[1]!
          yield TRIM_CHUNKS[2]!
          yield TRIM_CHUNKS[3]!
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: meterWith(() => 10),
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    const result = await executeTrim(ctx as never, invocationFor(agentFor(s), 'drop all'))
    expect(result.kind).toBe('success')
    // The first stream call (op-mode) fails transiently and its retry succeeds;
    // the prose output is reused as-is (no second rewrite call).
    expect(streamCalls).toBe(2) // op-mode: 1 initial + 1 retry
    const types = s.events.slice(before).map(e => e.type)
    expect(types).toEqual(['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
  })

  it('P8 retry: gives up after 3 attempts when the chunk keeps failing', async () => {
    const s = sessionWithTurns(5)
    let streamCalls = 0
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          streamCalls += 1
          throw new Error('persistent failure')
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: meterWith(() => 10),
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    await expect(executeTrim(ctx as never, invocationFor(agentFor(s), 'drop all')))
      .rejects.toThrow(DirectiveCompactionError)
    expect(streamCalls).toBe(3) // 1 initial + 2 retries
    expect(s.events[s.events.length - 1]!.type).toBe('compaction/end')
  })

  it('P8 retry: aborts during the first attempt and never starts a retry', async () => {
    const s = sessionWithTurns(5)
    let streamCalls = 0
    const controller = new AbortController()
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          streamCalls += 1
          // Abort on the first attempt; the retry loop must see signal.aborted
          // and stop without a second call.
          controller.abort()
          throw new Error('aborted')
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: meterWith(() => 10),
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    await expect(executeTrim(ctx as never, invocationFor(agentFor(s), 'drop all', controller.signal)))
      .rejects.toThrow(DirectiveCompactionError)
    expect(streamCalls).toBe(1) // no retry after abort
    // Lifecycle closed with an error; no replacement landed.
    expect(s.events[s.events.length - 1]!.type).toBe('compaction/end')
  })

  it('P8: splits a large surface into parallel chunks and assembles [part N/M]', async () => {
    const s = sessionWithTurns(5)
    const before = s.events.length
    // Full-freedom range = all 13 surface nodes (5 turns + 3 injected
    // skeleton) × 15K each; the per-chunk budget is 50K.
    let streamCalls = 0
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          streamCalls += 1
          yield TRIM_CHUNKS[0]!
          yield TRIM_CHUNKS[1]!
          yield TRIM_CHUNKS[2]!
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } as StreamChunk
          yield TRIM_CHUNKS[3]!
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: {
        estimateMessage: () => 10,
        measure: (sess: Session) => {
          const nodes = sess.surface.nodes.map(seq => ({ seq, tokens: 15_000 }))
          return { nodes, totalTokens: nodes.length * 15_000, surfaceTokens: nodes.length * 15_000 }
        },
      },
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    const result = await executeTrim(ctx as never, invocationFor(agentFor(s), 'drop all'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    // 13 nodes × 15K = 195K > 50K chunk budget → chunks of 3 nodes (45K):
    // 13 nodes = 4 full chunks + 1 remainder chunk = 5 chunks. Every chunk's
    // op-mode prose output is reused as-is (no second rewrite call) → 5
    // stream calls (one per chunk).
    expect(streamCalls).toBe(5)
    // Lifecycle still start → summary → replace → end.
    const types = s.events.slice(before).map(e => e.type)
    expect(types).toEqual(['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
    // The checkpoint contains [part N/5] markers.
    const summaryEvent = s.events[before + 1]!
    const summaryBlocks = (summaryEvent.data as { summary: { type: string; text: string }[] }).summary
    const text = summaryBlocks.map(b => b.text).join('\n')
    expect(text).toContain('[part 1/5]')
    expect(text).toContain('[part 5/5]')
    // The single head marker appears once; part bodies are appended.
    expect(text.split('[Directive trim, per requirement: drop all]').length - 1).toBe(1)
    // Usage is merged across the 5 calls.
    const usage = (summaryEvent.data as { usage?: { inputTokens: number } }).usage
    expect(usage?.inputTokens).toBe(5)
  })

  it('logs phase milestones with timings for a multi-chunk trim', async () => {
    const s = sessionWithTurns(5)
    const stub = createLoggerStub()
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          for (const chunk of TRIM_CHUNKS) yield chunk
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: {
        estimateMessage: () => 10,
        measure: (sess: Session) => {
          const nodes = sess.surface.nodes.map(seq => ({ seq, tokens: 15_000 }))
          return { nodes, totalTokens: nodes.length * 15_000, surfaceTokens: nodes.length * 15_000 }
        },
      },
      logger: stub.logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    const result = await executeTrim(ctx as never, invocationFor(agentFor(s), 'drop telemetry'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    const info = stub.records.filter(r => r.level === 'info')
    // Begin names the directive, the surface size, and the budget (the stub
    // records raw printf args: format string first, then the values).
    const begin = info.find(r => String(r.args[0]).includes('trim-directive: begin'))
    expect(begin).toBeDefined()
    expect(begin!.args[1]).toBe('drop telemetry')
    expect(begin!.args[2]).toBe(13) // surface nodes
    expect(begin!.args[5]).toBe(20) // max chunks
    // Per-chunk completion reports a duration; the summary reports the totals.
    expect(info.some(r => String(r.args[0]).includes('chunk %d/%d done in'))).toBe(true)
    expect(info.some(r => String(r.args[0]).includes('all %d chunks done in'))).toBe(true)
    const committed = info.find(r => String(r.args[0]).includes('trim-directive: committed'))
    expect(committed).toBeDefined()
    expect(committed!.args[0]).toContain('%dms total')
    // Chunk geometry is debug-level (hidden at the default console threshold).
    const debug = stub.records.filter(r => r.level === 'debug').map(r => r.args.join(' '))
    expect(debug.some(m => m.includes('chunk %d/%d — seqs'))).toBe(true)
  })

  /** Stream chunks that reply with exactly the no-change marker. */
  function noChangeChunks(): StreamChunk[] {
    return [
      { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk,
      { type: 'text-delta', index: 0, text: TRIM_NO_CHANGE_MARKER } as StreamChunk,
      { type: 'block-end', index: 0, block: { type: 'text', text: TRIM_NO_CHANGE_MARKER } } as StreamChunk,
      { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
    ]
  }

  /** Text of the landed compaction/summary checkpoint. */
  function checkpointText(session: Session): string {
    const summaryEvent = session.events.findLast(e => e.type === 'compaction/summary')!
    return (summaryEvent.data as { summary: { type: string; text: string }[] }).summary
      .map(b => b.text)
      .join('\n')
  }

  it('reports nothing to trim when the only chunk declares no change', async () => {
    const s = sessionWithTurns(5)
    const surfaceBefore = [...s.surface.nodes]
    // Content-keyed meter: the framed checkpoint (marker + guard + verbatim
    // original rendering) is larger than the shadowed span, so the trim is a
    // whole-surface no-change and reports it (not an error).
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          for (const chunk of noChangeChunks()) yield chunk
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: meterWith((message: { content: { type: string; text: string }[] }) => {
        const text = message.content.map(b => b.text).join('')
        return text.includes('[Directive trim, per requirement') ? 1000 : 10
      }),
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    const result = await executeTrim(ctx as never, invocationFor(agentFor(s), 'delete nothing here'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    // Whole-surface no-change: the verbatim checkpoint is not smaller than the
    // shadowed span, so the P10.3 no-change path reports it (not an error).
    expect(result.text).toContain('Nothing to trim')
    expect(s.surface.nodes).toEqual(surfaceBefore)
    expect(checkpointText(s)).not.toContain(TRIM_NO_CHANGE_MARKER)
  })

  it('keeps a no-change chunk verbatim and assembles changed chunks from the model', async () => {
    const s = sessionWithTurns(5)
    let streamCalls = 0
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          streamCalls += 1
          if (streamCalls === 1) {
            for (const chunk of noChangeChunks()) yield chunk
          } else {
            for (const chunk of TRIM_CHUNKS) yield chunk
          }
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: {
        estimateMessage: () => 10,
        measure: (sess: Session) => {
          const nodes = sess.surface.nodes.map(seq => ({ seq, tokens: 15_000 }))
          return { nodes, totalTokens: nodes.length * 15_000, surfaceTokens: nodes.length * 15_000 }
        },
      },
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    const result = await executeTrim(ctx as never, invocationFor(agentFor(s), 'drop all'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    // 13 nodes × 15K = 195K > 50K → 5 chunks. Chunk 1 declares no change in
    // its op-mode call (1 stream call); chunks 2-5 output prose, which is
    // reused as-is (1 stream call each, no second call) → 5 total.
    expect(streamCalls).toBe(5)
    const text = checkpointText(s)
    // Chunk 1's original rendering survives verbatim (the role-prefixed span).
    expect(text).toContain('[part 1/5]')
    expect(text).toContain('[user] first task')
    expect(text).toContain('[assistant] first answer')
    // The changed chunks contribute the model's output.
    expect(text).toContain('[part 2/5]')
    expect(text).toContain('trimmed context')
    // The marker itself never lands in the checkpoint.
    expect(text).not.toContain(TRIM_NO_CHANGE_MARKER)
  })

  it('treats a marker embedded in other content as changed (no marker abuse)', async () => {
    const s = sessionWithTurns(5)
    const mixedChunks = [
      { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk,
      { type: 'text-delta', index: 0, text: `keep this ${TRIM_NO_CHANGE_MARKER} inline` } as StreamChunk,
      { type: 'block-end', index: 0, block: { type: 'text', text: `keep this ${TRIM_NO_CHANGE_MARKER} inline` } } as StreamChunk,
      { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
    ]
    const ctx = fakeCtx(mixedChunks)
    const result = await executeTrim(ctx as never, invocationFor(agentFor(s), 'drop all'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    // Not a pure marker reply → assembled as normal content.
    expect(checkpointText(s)).toContain(`keep this ${TRIM_NO_CHANGE_MARKER} inline`)
  })

  it('P11: executes an op-mode delete manifest into the checkpoint', async () => {
    const s = sessionWithTurns(5)
    const target = s.surface.nodes[0]! // the 'first task' user node
    const manifestChunks = [
      { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk,
      { type: 'text-delta', index: 0, text: `delete: ${target}` } as StreamChunk,
      { type: 'block-end', index: 0, block: { type: 'text', text: `delete: ${target}` } } as StreamChunk,
      { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
    ]
    const result = await executeTrim(fakeCtx(manifestChunks) as never, invocationFor(agentFor(s), 'drop the first task'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    const text = checkpointText(s)
    // The deleted node is gone; the rest of the chunk splices verbatim.
    expect(text).not.toContain('[user] first task')
    expect(text).toContain('[assistant] first answer')
    expect(text).toContain('[user] rules')
    // No marker/fallback artifacts: the checkpoint is the executed manifest.
    expect(text).not.toContain('delete:')
  })

  it('P11: executes an op-mode rewrite manifest with the model content', async () => {
    const s = sessionWithTurns(5)
    const target = s.surface.nodes[0]!
    const rewrite = `rewrite: ${target}\n---content---\nrewritten task\n---end---`
    const manifestChunks = [
      { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk,
      { type: 'text-delta', index: 0, text: rewrite } as StreamChunk,
      { type: 'block-end', index: 0, block: { type: 'text', text: rewrite } } as StreamChunk,
      { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
    ]
    const result = await executeTrim(fakeCtx(manifestChunks) as never, invocationFor(agentFor(s), 'rework the first task'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    const text = checkpointText(s)
    // The node's role prefix is re-added; the model content replaces the node.
    expect(text).toContain('[user] rewritten task')
    expect(text).not.toContain('[user] first task')
  })

  it('P11 regression (real-run finding): reuses prose op-mode output with ONE call per chunk', async () => {
    // Real "复杂对话4" run: the model emitted prose on 9/9 chunks and the old
    // fallback made a SECOND rewrite call per chunk → 13.8 min (2.3× the
    // rewrite baseline). The prose output IS the model's rewrite; reusing it
    // must cost exactly one stream call per chunk.
    const s = sessionWithTurns(5)
    let streamCalls = 0
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          streamCalls += 1
          for (const chunk of TRIM_CHUNKS) yield chunk
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: meterWith(() => 10),
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    const result = await executeTrim(ctx as never, invocationFor(agentFor(s), 'drop all'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    // One chunk (13 nodes × 10 tokens = 130 ≤ 50K) → exactly ONE call; the
    // prose output lands in the checkpoint without a second rewrite call.
    expect(streamCalls).toBe(1)
    expect(checkpointText(s)).toContain('trimmed context')
  })

  it('P11: a parseable but invalid manifest falls back to ONE rewrite call', async () => {
    // A well-formed manifest with an out-of-range seq cannot execute (the
    // op-mode output is a manifest, NOT usable as content), so the rewrite
    // call runs once: 2 stream calls total for the chunk.
    const s = sessionWithTurns(5)
    let streamCalls = 0
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          streamCalls += 1
          if (streamCalls === 1) {
            const text = 'delete: 999999'
            yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
            yield { type: 'text-delta', index: 0, text } as StreamChunk
            yield { type: 'block-end', index: 0, block: { type: 'text', text } } as StreamChunk
            yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
          } else {
            for (const chunk of TRIM_CHUNKS) yield chunk
          }
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: meterWith(() => 10),
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    const result = await executeTrim(ctx as never, invocationFor(agentFor(s), 'drop all'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    expect(streamCalls).toBe(2) // op call + rewrite fallback
    const text = checkpointText(s)
    expect(text).toContain('trimmed context') // the rewrite call's output
    expect(text).not.toContain('delete:')
  })

  /** Session with one tool call/result pair: [user1, asst1, user2, call, result]. */
  function sessionWithToolTurn(): Session {
    const s = Session.create(SessionId('trim-tool-test'))
    appendTurn(s, 1, 'first task', 'first answer')
    s.append('turn/start', { turn: 2 })
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'run read' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    s.append('step/start', { turn: 2, step: 1 })
    s.append('assistant/message', {
      turn: 2,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('t-call-1'), name: 'read', arguments: '{}' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    s.append('step/end', { turn: 2, step: 1 })
    s.append('tool/result', {
      turn: 2,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('t-call-1'),
        content: [{ type: 'text', text: 'telemetry payload here' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    s.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    return s
  }

  it('P11 fix: rewrites a tool-result node (partial telemetry) with ONE call — no pair-balance rejection', async () => {
    // "delete a little telemetry inside a tool result" must be a rewrite of
    // that single node: the node stays, the call/result structure is intact,
    // so the trim must NOT fall back to a rewrite call over pair balance.
    const s = sessionWithToolTurn()
    const resultSeq = s.surface.nodes[4]!
    const rewrite = `rewrite: ${resultSeq}\n---content---\npayload without telemetry\n---end---`
    let streamCalls = 0
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          streamCalls += 1
          yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
          yield { type: 'text-delta', index: 0, text: rewrite } as StreamChunk
          yield { type: 'block-end', index: 0, block: { type: 'text', text: rewrite } } as StreamChunk
          yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: meterWith(() => 10),
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    const result = await executeTrim(ctx as never, invocationFor(agentFor(s), 'remove telemetry from the result'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    expect(streamCalls).toBe(1) // executed in op mode — no fallback call
    const text = checkpointText(s)
    expect(text).toContain('[user] payload without telemetry') // rewritten result (role prefix re-added)
    expect(text).not.toContain('telemetry payload here')
    expect(text).toContain('[assistant] called tool read') // the call stays intact
  })

  it('P11 fix: extends a one-sided delete of a tool result to its call with ONE call', async () => {
    // The model wants the whole tool record gone but names only the result;
    // the plugin pulls the paired call in and executes — no fallback call.
    const s = sessionWithToolTurn()
    const resultSeq = s.surface.nodes[4]!
    const manifest = `delete: ${resultSeq}`
    let streamCalls = 0
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          streamCalls += 1
          yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
          yield { type: 'text-delta', index: 0, text: manifest } as StreamChunk
          yield { type: 'block-end', index: 0, block: { type: 'text', text: manifest } } as StreamChunk
          yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: meterWith(() => 10),
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    const result = await executeTrim(ctx as never, invocationFor(agentFor(s), 'delete the read result'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    expect(streamCalls).toBe(1) // executed in op mode — no fallback call
    const text = checkpointText(s)
    expect(text).not.toContain('telemetry payload here') // result gone
    expect(text).not.toContain('called tool read') // paired call pulled in
    expect(text).toContain('[user] first task') // everything else verbatim
  })

  it('P11 fix: rewrites a tool-call node by auto-deleting its paired result (ONE call)', async () => {
    // Real run (chunk 5, seq 16219): the model rewrote an assistant node that
    // CARRIES tool calls (text + subagent calls). The rewrite replaces the
    // whole node, so its paired results are auto-extended into deletes —
    // executed in op mode, no fallback call.
    const s = sessionWithToolTurn()
    const callSeq = s.surface.nodes[3]!
    const rewrite = `rewrite: ${callSeq}\n---content---\nreplaced call text\n---end---`
    let streamCalls = 0
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          streamCalls += 1
          yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
          yield { type: 'text-delta', index: 0, text: rewrite } as StreamChunk
          yield { type: 'block-end', index: 0, block: { type: 'text', text: rewrite } } as StreamChunk
          yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: meterWith(() => 10),
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    const result = await executeTrim(ctx as never, invocationFor(agentFor(s), 'rewrite the call message'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    expect(streamCalls).toBe(1) // executed in op mode — no fallback call
    const text = checkpointText(s)
    expect(text).toContain('[assistant] replaced call text') // the rewritten node
    expect(text).not.toContain('called tool read') // the call is gone with the node
    expect(text).not.toContain('telemetry payload here') // paired result auto-deleted
    expect(text).toContain('[user] first task') // everything else verbatim
  })

  it('P11 fix: a delete+rewrite pair conflict is rejected and falls back to a rewrite call', async () => {
    // `delete: <call>` + `rewrite: <result>`: the delete extension must NOT
    // silently pull the rewritten result into deletes; the conflict rejects
    // and the rewrite-mode fallback produces the result.
    const s = sessionWithToolTurn()
    const callSeq = s.surface.nodes[3]!
    const resultSeq = s.surface.nodes[4]!
    const manifest = `delete: ${callSeq}\nrewrite: ${resultSeq}\n---content---\nkept result content\n---end---`
    let streamCalls = 0
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          streamCalls += 1
          if (streamCalls === 1) {
            yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
            yield { type: 'text-delta', index: 0, text: manifest } as StreamChunk
            yield { type: 'block-end', index: 0, block: { type: 'text', text: manifest } } as StreamChunk
            yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
          } else {
            for (const chunk of TRIM_CHUNKS) yield chunk
          }
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: meterWith(() => 10),
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    const result = await executeTrim(ctx as never, invocationFor(agentFor(s), 'drop the call, keep the result'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    expect(streamCalls).toBe(2) // op call rejected → rewrite fallback call
    const text = checkpointText(s)
    expect(text).toContain('trimmed context') // the fallback's output
    expect(text).not.toContain('kept result content') // the conflicted manifest did not execute
  })

  it('P12: executes a delete-text manifest with ONE call (fragment removal)', async () => {
    // The P12 answer to "delete a little telemetry scattered inside a node":
    // the model names the exact fragment, the plugin removes it verbatim —
    // zero regeneration, no inflation, one call.
    const s = sessionWithTurns(5)
    const target = s.surface.nodes[0]! // '[user] first task'
    const manifest = `delete-text: ${target}, "first"`
    let streamCalls = 0
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          streamCalls += 1
          yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
          yield { type: 'text-delta', index: 0, text: manifest } as StreamChunk
          yield { type: 'block-end', index: 0, block: { type: 'text', text: manifest } } as StreamChunk
          yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        },
        async resolveModelInfo(): Promise<{ context: { contextWindow: number } }> {
          return { context: { contextWindow: 1_000_000 } }
        },
      },
      tokenMeter: meterWith(() => 10),
      logger: createLoggerStub().logger,
    } as unknown as Pick<Context, 'llm' | 'tokenMeter' | 'logger'>
    const result = await executeTrim(ctx as never, invocationFor(agentFor(s), 'remove the word first from the opening'))
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    expect(streamCalls).toBe(1) // executed in op mode — no fallback call
    const text = checkpointText(s)
    expect(text).toContain('[user]  task') // fragment removed, rest verbatim
    expect(text).not.toContain('[user] first')
    expect(text).toContain('[assistant] first answer') // untouched node verbatim
  })
})
