import { describe, expect, it } from 'vitest'
import { CallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  buildOpModePrompt,
  executeOpManifest,
  parseOpManifest,
  renderSpanNumbered,
  validateOpManifest,
  type OpManifest,
} from '../src/op-mode.js'
import { TRIM_NO_CHANGE_MARKER } from '../src/trim.js'

/** Append one plain user turn (user message + assistant reply) to a session. */
function appendTurn(session: Session, turn: number, userText: string, assistantText: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: userText }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: assistantText }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Append a turn whose assistant reply is one tool call, plus its result. */
function appendToolTurn(session: Session, turn: number, userText: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: userText }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: CallId('op-call-1'), name: 'check', arguments: '{}' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId: CallId('op-call-1'),
      content: [{ type: 'text', text: 'check result text' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Session: turn 1 plain, turn 2 tool pair, turn 3 plain → 7 surface nodes. */
function fixtureSession(): Session {
  const s = Session.create(SessionId('op-mode-test'))
  appendTurn(s, 1, 'first task', 'first answer')
  appendToolTurn(s, 2, 'run check')
  appendTurn(s, 3, 'third task', 'third answer')
  return s
}

/** seq → derived message map for the fixture surface. */
function messagesBySeq(session: Session): Map<number, ReturnType<Session['deriveEventMessage']>> {
  const map = new Map()
  for (const seq of session.surface.nodes) {
    map.set(seq, session.deriveEventMessage(session.events[seq]!))
  }
  return map
}

describe('renderSpanNumbered', () => {
  it('prefixes node-start lines with the global seq and indents continuation lines', () => {
    const s = fixtureSession()
    const rendered = renderSpanNumbered(s.surface.nodes, messagesBySeq(s) as never)
    const lines = rendered.split('\n')
    expect(lines[0]).toMatch(/^\[seq \d+\] \[user\] first task$/)
    // The tool-result node derives as a user-role message (same as renderSpan);
    // its nested result block is an in-node continuation line (indented).
    const resultLine = lines.find(line => line.includes('tool result:'))
    expect(resultLine).toMatch(/^\[seq \d+\] \[user\] tool result:$/)
    const nested = lines[lines.indexOf(resultLine!) + 1]!
    expect(nested.startsWith('  [tool] ')).toBe(true)
  })
})

describe('buildOpModePrompt', () => {
  it('teaches the manifest grammar and embeds the directive verbatim', () => {
    const prompt = buildOpModePrompt('delete telemetry')
    expect(prompt).toContain('delete:')
    expect(prompt).toContain('rewrite:')
    expect(prompt).toContain('summarize:')
    expect(prompt).toContain('---content---')
    expect(prompt).toContain(TRIM_NO_CHANGE_MARKER)
    expect(prompt).toContain('delete telemetry')
  })
  it('fails loud on an empty requirement', () => {
    expect(() => buildOpModePrompt('')).toThrow(/non-empty requirement/)
    expect(() => buildOpModePrompt(undefined)).toThrow(/non-empty requirement/)
  })
})

describe('parseOpManifest', () => {
  it('treats empty output and the marker alone as no-change', () => {
    expect(parseOpManifest('')).toEqual({ kind: 'no-change' })
    expect(parseOpManifest('  \n ')).toEqual({ kind: 'no-change' })
    expect(parseOpManifest(TRIM_NO_CHANGE_MARKER)).toEqual({ kind: 'no-change' })
  })
  it('parses delete lists and ranges', () => {
    const parsed = parseOpManifest('delete: 3, 5-7')
    expect(parsed.kind).toBe('manifest')
    if (parsed.kind !== 'manifest') return
    expect(parsed.manifest.deletes).toEqual([3, 5, 6, 7])
  })
  it('parses rewrite with its content block', () => {
    const parsed = parseOpManifest('rewrite: 2\n---content---\nnew version\nof the node\n---end---')
    expect(parsed.kind).toBe('manifest')
    if (parsed.kind !== 'manifest') return
    expect(parsed.manifest.rewrites.get(2)).toBe('new version\nof the node')
  })
  it('parses summarize with its content block', () => {
    const parsed = parseOpManifest('summarize: 3-5\n---content---\nsummary text\n---end---')
    expect(parsed.kind).toBe('manifest')
    if (parsed.kind !== 'manifest') return
    expect(parsed.manifest.summarizes).toEqual([{ start: 3, end: 5, summary: 'summary text' }])
  })
  it('parses a mixed manifest', () => {
    const parsed = parseOpManifest(
      'delete: 1\nrewrite: 2\n---content---\nrewritten\n---end---\nsummarize: 4-5\n---content---\nsum\n---end---',
    )
    expect(parsed.kind).toBe('manifest')
    if (parsed.kind !== 'manifest') return
    expect(parsed.manifest.deletes).toEqual([1])
    expect(parsed.manifest.rewrites.get(2)).toBe('rewritten')
    expect(parsed.manifest.summarizes).toEqual([{ start: 4, end: 5, summary: 'sum' }])
  })
  it('rejects prose, unknown lines, and indented operations', () => {
    expect(parseOpManifest('the trimmed context is this…')).toMatchObject({ kind: 'invalid' })
    expect(parseOpManifest('drop: 1')).toMatchObject({ kind: 'invalid' })
    expect(parseOpManifest('  delete: 1')).toMatchObject({ kind: 'invalid' })
  })
  it('rejects a rewrite/summarize without its content block', () => {
    expect(parseOpManifest('rewrite: 2')).toMatchObject({ kind: 'invalid' })
    expect(parseOpManifest('rewrite: 2\n---content---\ntext')).toMatchObject({ kind: 'invalid' })
    expect(parseOpManifest('summarize: 2-3')).toMatchObject({ kind: 'invalid' })
  })
  it('rejects an empty content block and unpaired delimiters', () => {
    expect(parseOpManifest('rewrite: 2\n---content---\n---end---')).toMatchObject({ kind: 'invalid' })
    expect(parseOpManifest('---content---\ntext\n---end---')).toMatchObject({ kind: 'invalid' })
    expect(parseOpManifest('rewrite: 2\n---end---')).toMatchObject({ kind: 'invalid' })
  })
  it('rejects the no-change marker mixed with operations', () => {
    expect(parseOpManifest(`delete: 1\n${TRIM_NO_CHANGE_MARKER}`)).toMatchObject({ kind: 'invalid' })
  })
  it('rejects malformed numbers', () => {
    expect(parseOpManifest('delete: a')).toMatchObject({ kind: 'invalid' })
    expect(parseOpManifest('summarize: 5-3')).toMatchObject({ kind: 'invalid' })
    expect(parseOpManifest('rewrite: 1-2')).toMatchObject({ kind: 'invalid' })
  })
})

describe('validateOpManifest', () => {
  it('accepts a manifest whose seqs are all chunk members with balanced boundaries', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const manifest: OpManifest = { deletes: [seqs[0]!], rewrites: new Map(), summarizes: [] }
    expect(validateOpManifest(manifest, seqs, s)).toBeNull()
  })
  it('rejects seqs outside the chunk and overlaps', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    expect(validateOpManifest({ deletes: [999_999], rewrites: new Map(), summarizes: [] }, seqs, s))
      .toContain('not in this chunk')
    const manifest: OpManifest = {
      deletes: [seqs[0]!],
      rewrites: new Map([[seqs[0]!, 'x']]),
      summarizes: [],
    }
    expect(validateOpManifest(manifest, seqs, s)).toContain('overlap')
  })
  it('rejects deleting only one side of a tool pair, accepts the whole pair', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    // seqs: [user1, assistant1, user2, call, result, user3, assistant3]
    const callIdx = seqs.findIndex((_, i) => i === 3)
    const call = seqs[callIdx]!
    const result = seqs[callIdx + 1]!
    expect(validateOpManifest({ deletes: [call], rewrites: new Map(), summarizes: [] }, seqs, s))
      .toContain('split a tool call/result pair')
    expect(validateOpManifest({ deletes: [result], rewrites: new Map(), summarizes: [] }, seqs, s))
      .toContain('split a tool call/result pair')
    expect(validateOpManifest({ deletes: [call, result], rewrites: new Map(), summarizes: [] }, seqs, s)).toBeNull()
  })
  it('rejects rewriting a lone tool-call node', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const call = seqs[3]!
    const manifest: OpManifest = { deletes: [], rewrites: new Map([[call, 'x']]), summarizes: [] }
    expect(validateOpManifest(manifest, seqs, s)).toContain('split a tool call/result pair')
  })
  it('rejects a summarize range whose boundary seqs are missing or inverted', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    expect(validateOpManifest({
      deletes: [], rewrites: new Map(),
      summarizes: [{ start: seqs[1]!, end: 999_999, summary: 'x' }],
    }, seqs, s)).toContain('not in this chunk')
    expect(validateOpManifest({
      deletes: [], rewrites: new Map(),
      summarizes: [{ start: seqs[3]!, end: seqs[1]!, summary: 'x' }],
    }, seqs, s)).toContain('inverted')
  })
})

describe('executeOpManifest', () => {
  it('splices everything verbatim for a null (no-change) manifest', () => {
    const s = fixtureSession()
    const out = executeOpManifest(null, s.surface.nodes, s)
    expect(out).toContain('[user] first task')
    expect(out).toContain('[user] third task')
  })
  it('drops deleted nodes, replaces rewrite nodes with the role-prefixed content', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const manifest: OpManifest = {
      deletes: [seqs[0]!],
      rewrites: new Map([[seqs[1]!, 'rewritten answer']]),
      summarizes: [],
    }
    const out = executeOpManifest(manifest, seqs, s)
    expect(out).not.toContain('[user] first task')
    expect(out).toContain('[assistant] rewritten answer')
    expect(out).toContain('[user] run check')
  })
  it('replaces a summarize range with its summary text', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const manifest: OpManifest = {
      deletes: [],
      rewrites: new Map(),
      summarizes: [{ start: seqs[2]!, end: seqs[4]!, summary: 'the summary' }],
    }
    const out = executeOpManifest(manifest, seqs, s)
    expect(out).toContain('the summary')
    expect(out).not.toContain('[user] run check')
    expect(out).not.toContain('tool result:')
    expect(out).toContain('[user] third task')
  })
  it('executes a mixed manifest in node order', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const manifest: OpManifest = {
      deletes: [seqs[4]!], // result dropped
      rewrites: new Map([[seqs[1]!, 'fixed']]),
      summarizes: [{ start: seqs[5]!, end: seqs[6]!, summary: 'tail' }],
    }
    const out = executeOpManifest(manifest, seqs, s)
    expect(out).toContain('[user] first task')
    expect(out).toContain('[assistant] fixed')
    expect(out).toContain('[user] run check')
    expect(out).toContain('[assistant] called tool check')
    expect(out).not.toContain('tool result:')
    expect(out).toContain('tail')
    expect(out).not.toContain('third task')
  })
})
