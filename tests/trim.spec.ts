import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { buildTrimPrompt, TRIM_INSTRUCTION, trimMarker } from '../src/trim.js'
import { executeTrim, isInjectedSystemNode } from '../src/command-trim.js'
import { DirectiveCompactionError } from '../src/command.js'

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

describe('isInjectedSystemNode', () => {
  it('classifies plugin-sourced user messages as injected system nodes', () => {
    expect(isInjectedSystemNode('agent-instructions', 'user/message')).toBe(true)
    expect(isInjectedSystemNode('@deepseek-ai/dsh-system-prompt', 'user/message')).toBe(true)
    expect(isInjectedSystemNode('skill-catalog', 'user/message')).toBe(true)
    expect(isInjectedSystemNode('compact', 'user/message')).toBe(true)
  })
  it('classifies genuine user utterances as trim-able dialogue', () => {
    expect(isInjectedSystemNode('user', 'user/message')).toBe(false)
    expect(isInjectedSystemNode('assistant/message', 'assistant/message')).toBe(false)
    expect(isInjectedSystemNode('tool/result', 'tool/result')).toBe(false)
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

function invocationFor(agent: Agent, rawInput: string): CommandInvocation {
  return {
    commandId: 'trim-1' as unknown as CommandId,
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

  it('returns success with no changes when there is no conversational content', async () => {
    const s = Session.create(SessionId('trim-empty'))
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'rules' }], source: { kind: 'plugin', plugin: 'agent-instructions' },
    }), { surfaceOp: 'append' })
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

  it('preserves the injected system nodes outside the trim range', async () => {
    const s = sessionWithTurns(5)
    const result = await executeTrim(fakeCtx(TRIM_CHUNKS) as never, invocationFor(agentFor(s), 'drop all dialogue'))
    expect(result.kind).toBe('success')
    // The system injections survive verbatim.
    const text = surfaceText(s)
    expect(text).toContain('rules')
    expect(text).toContain('ctx')
    expect(text).toContain('skills')
    // The replaced checkpoint lands after them.
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
      },
      tokenMeter: { estimateMessage: () => 10 },
    } as unknown as Pick<Context, 'llm' | 'tokenMeter'>
    await executeTrim(ctx as never, invocationFor(agentFor(s), '删除所有和 doc 相关的内容'))
    expect(seenPrompt).toContain('删除所有和 doc 相关的内容')
    // The injected system nodes are NOT rendered into the prompt.
    expect(seenPrompt).not.toContain('rules')
    expect(seenPrompt).not.toContain('skills')
  })

  it('refuses standalone trim while a turn is open (busy)', async () => {
    const s = sessionWithTurns(5)
    s.append('turn/start', { turn: 9 })
    await expect(executeTrim(fakeCtx(TRIM_CHUNKS) as never, invocationFor(agentFor(s), 'drop all')))
      .rejects.toThrow(DirectiveCompactionError)
    expect(s.events.some(e => e.type === 'compaction/start')).toBe(false)
  })

  it('rejects a trim whose checkpoint is not smaller than the shadowed span (shrink)', async () => {
    const s = sessionWithTurns(5)
    const ctx = fakeCtx(TRIM_CHUNKS)
    // Distinguish the framed checkpoint from the shadowed nodes by content:
    // the checkpoint carries the trim marker + guard, the shadowed
    // conversation messages do not. Survives estimateMessage call-count
    // changes, unlike a positional "first N calls are shadowed" threshold.
    const inflated = {
      llm: ctx.llm,
      tokenMeter: {
        estimateMessage: (message: { content: { type: string; text: string }[] }) => {
          const text = message.content.map(b => b.text).join('')
          return text.includes('[Directive trim, per requirement') ? 1000 : 10
        },
      },
    } as unknown as Pick<Context, 'llm' | 'tokenMeter'>
    await expect(executeTrim(inflated as never, invocationFor(agentFor(s), 'drop all')))
      .rejects.toThrow(DirectiveCompactionError)
    // The lifecycle is still closed.
    expect(s.events[s.events.length - 1]!.type).toBe('compaction/end')
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

  it('regression: a cancelled trim leaves the surface intact', async () => {
    const s = sessionWithTurns(5)
    const surfaceBefore = [...s.surface.nodes]
    const ctx = {
      llm: {
        async *stream(): AsyncIterable<StreamChunk> {
          throw new Error('This operation was aborted')
        },
      },
      tokenMeter: { estimateMessage: () => 10 },
    } as unknown as Pick<Context, 'llm' | 'tokenMeter'>
    await expect(executeTrim(ctx as never, invocationFor(agentFor(s), 'drop all')))
      .rejects.toThrow()
    expect(s.events[s.events.length - 1]!.type).toBe('compaction/end')
    expect(s.surface.nodes).toEqual(surfaceBefore)
  })
})
