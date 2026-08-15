import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  buildSummaryPrompt,
  CHECKPOINT_GUARD,
  checkpointMarker,
  FOUR_POINT_INSTRUCTION,
  renderSpan,
  summarizeWithDirective,
  type DirectiveTarget,
} from '../src/summarizer.ts'

/** A fake context whose `llm.stream` yields the given chunks. */
function fakeCtx(chunks: readonly StreamChunk[]): Pick<Context, 'llm'> {
  return {
    llm: {
      async *stream(): AsyncIterable<StreamChunk> {
        for (const chunk of chunks) yield chunk
      },
    } as unknown as Context['llm'],
  } as unknown as Pick<Context, 'llm'>
}

function textChunk(index: number): StreamChunk {
  return { type: 'block-start', index, blockType: 'text' } as StreamChunk
}

function textDelta(index: number, text: string): StreamChunk {
  return { type: 'text-delta', index, text } as StreamChunk
}

function blockEnd(index: number, block: { type: 'text'; text: string }): StreamChunk {
  return { type: 'block-end', index, block } as StreamChunk
}

const TARGET: DirectiveTarget = { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 4096 }

describe('buildSummaryPrompt', () => {
  it('returns the four-point baseline alone without a directive', () => {
    expect(buildSummaryPrompt(undefined)).toBe(FOUR_POINT_INSTRUCTION)
  })
  it('layers the directive over the four-point baseline', () => {
    const prompt = buildSummaryPrompt('keep login')
    expect(prompt).toContain('This compaction has a user-specified special requirement')
    expect(prompt).toContain('keep login')
    expect(prompt).toContain('follow it first')
    expect(prompt).toContain(FOUR_POINT_INSTRUCTION)
  })
})

describe('checkpointMarker / CHECKPOINT_GUARD', () => {
  it('names the directive in the marker', () => {
    expect(checkpointMarker('keep login')).toBe('[Directive-driven compaction checkpoint, per requirement: keep login]')
  })
  it('guard forbids reconstruction', () => {
    expect(CHECKPOINT_GUARD).toContain('removed on purpose')
    expect(CHECKPOINT_GUARD).toContain('do not reconstruct')
  })
})

describe('renderSpan', () => {
  it('renders text blocks with role prefixes', () => {
    const messages = [{
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
    }]
    expect(renderSpan(messages as never)).toBe('[user] hello')
  })
  it('renders tool-call and tool-result blocks', () => {
    const messages = [{
      role: 'assistant' as const,
      content: [
        { type: 'tool-call' as const, name: 'read_file', arguments: '{"path":"a.ts"}' },
      ],
    }, {
      role: 'user' as const,
      content: [
        { type: 'tool-result' as const, content: [{ type: 'text' as const, text: 'file content' }] },
      ],
    }]
    const rendered = renderSpan(messages as never)
    expect(rendered).toContain('called tool read_file')
    expect(rendered).toContain('tool result:')
    expect(rendered).toContain('[tool] file content')
  })
})

describe('summarizeWithDirective', () => {
  it('returns the text summary with the directive marker and guard', async () => {
    const ctx = fakeCtx([
      textChunk(0),
      textDelta(0, 'keep login'),
      blockEnd(0, { type: 'text', text: 'keep login' }),
      { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
    ])
    const result = await summarizeWithDirective(
      ctx as never, TARGET, [], 'keep login', 'session-1' as never,
    )
    expect(result.provider).toBe('deepseek-official')
    expect(result.model).toBe('deepseek-v4-flash')
    const texts = result.summary.map(b => b.type === 'text' ? b.text : '')
    expect(texts[0]).toBe(checkpointMarker('keep login'))
    expect(texts[1]).toBe(CHECKPOINT_GUARD)
    expect(texts.join('')).toContain('keep login')
  })

  it('omits the marker when no directive is present', async () => {
    const ctx = fakeCtx([
      textChunk(0),
      textDelta(0, 'plain summary'),
      blockEnd(0, { type: 'text', text: 'plain summary' }),
      { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
    ])
    const result = await summarizeWithDirective(ctx as never, TARGET, [], undefined, 'session-1' as never)
    const texts = result.summary.map(b => b.type === 'text' ? b.text : '')
    expect(texts[0]).toBe(CHECKPOINT_GUARD) // no marker, guard first
    expect(texts.some(t => t.includes('Directive-driven'))).toBe(false)
  })

  it('rejects image output', async () => {
    const ctx = fakeCtx([
      textChunk(0),
      { type: 'block-end', index: 0, block: { type: 'image', source: { type: 'inline', data: 'x' } } } as unknown as StreamChunk,
      { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
    ])
    await expect(summarizeWithDirective(ctx as never, TARGET, [], 'keep', 'session-1' as never))
      .rejects.toThrow(/image output/)
  })

  it('rejects empty text output', async () => {
    const ctx = fakeCtx([
      textChunk(0),
      textDelta(0, '   '),
      blockEnd(0, { type: 'text', text: '   ' }),
      { type: 'finish', reason: { kind: 'stop' } } as StreamChunk,
    ])
    await expect(summarizeWithDirective(ctx as never, TARGET, [], 'keep', 'session-1' as never))
      .rejects.toThrow(/no text summary content/)
  })

  it('maps a max-tokens finish to a fail-closed error', async () => {
    const ctx = fakeCtx([
      { type: 'finish', reason: { kind: 'max-tokens' } } as StreamChunk,
    ])
    await expect(summarizeWithDirective(ctx as never, TARGET, [], 'keep', 'session-1' as never))
      .rejects.toThrow(/truncated at the token cap/)
  })

  it('maps an error finish to a code-carrying error', async () => {
    const ctx = fakeCtx([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'E_TEST' } } } as StreamChunk,
    ])
    try {
      await summarizeWithDirective(ctx as never, TARGET, [], 'keep', 'session-1' as never)
      expect.unreachable('should throw')
    } catch (error) {
      expect((error as Error).message).toBe('boom')
      expect((error as Error & { code?: string }).code).toBe('E_TEST')
    }
  })

  it('fails loud on an oversized rendered input', async () => {
    const ctx = fakeCtx([])
    const huge = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'x'.repeat(4_000_001) }],
    }
    await expect(summarizeWithDirective(ctx as never, TARGET, [huge] as never, 'keep', 'session-1' as never))
      .rejects.toThrow(/input too large/)
  })
})