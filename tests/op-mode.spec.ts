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
  it('teaches the manifest grammar, the full-rewrite alternative, and embeds the directive verbatim', () => {
    const prompt = buildOpModePrompt('delete telemetry')
    expect(prompt).toContain('delete:')
    expect(prompt).toContain('delete-text:')
    expect(prompt).toContain('rewrite:')
    expect(prompt).toContain('summarize:')
    expect(prompt).toContain('---content---')
    expect(prompt).toContain(TRIM_NO_CHANGE_MARKER)
    // Form 2: a full rewrite is a legal reply (the plugin reuses it as-is).
    expect(prompt).toContain('FORM 2')
    expect(prompt).toContain('trimmed context in full')
    // Node-targeting guidance: edit a result's content via the result node,
    // never a tool-call node (which deletes the call AND its result); prefer
    // delete over rewrite for whole-node removal.
    expect(prompt).toContain('NEVER a tool-call node')
    expect(prompt).toContain('Prefer delete over rewrite')
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
  it('parses delete-text with a quoted fragment', () => {
    const parsed = parseOpManifest('delete-text: 3, "telemetry line"')
    expect(parsed.kind).toBe('manifest')
    if (parsed.kind !== 'manifest') return
    expect(parsed.manifest.deleteTexts).toEqual([{ seq: 3, fragment: 'telemetry line' }])
  })
  it('parses delete-text fragments containing escaped quotes and unclosed quotes', () => {
    // Real model output (16:05 run): code fragments contain quotes, the model
    // escapes them as \" and may leave the closing quote off.
    const escaped = parseOpManifest('delete-text: 3, "pkg[\"session-telemetry"]')
    expect(escaped.kind).toBe('manifest')
    if (escaped.kind === 'manifest') {
      expect(escaped.manifest.deleteTexts).toEqual([{ seq: 3, fragment: 'pkg["session-telemetry"]' }])
    }
    const unclosed = parseOpManifest('delete-text: 3, "unclosed fragment')
    expect(unclosed.kind).toBe('manifest')
    if (unclosed.kind === 'manifest') {
      expect(unclosed.manifest.deleteTexts).toEqual([{ seq: 3, fragment: 'unclosed fragment' }])
    }
  })
  it('parses a bare (unquoted) delete-text fragment to end of line', () => {
    const parsed = parseOpManifest('delete-text: 3, telemetry line with spaces')
    expect(parsed.kind).toBe('manifest')
    if (parsed.kind !== 'manifest') return
    expect(parsed.manifest.deleteTexts).toEqual([{ seq: 3, fragment: 'telemetry line with spaces' }])
  })
  it('keeps backslash sequences literal in fragments (renderings contain escaped backslashes)', () => {
    // Tool outputs render Windows paths as literal \\ (e.g. docs\\subsystems\x).
    // The model copies them verbatim; the parser must NOT unescape them.
    const parsed = parseOpManifest('delete-text: 3, "docs\\\\subsystems\\\\x.md"')
    expect(parsed.kind).toBe('manifest')
    if (parsed.kind !== 'manifest') return
    expect(parsed.manifest.deleteTexts).toEqual([{ seq: 3, fragment: 'docs\\\\subsystems\\\\x.md' }])
  })
  it('rejects malformed delete-text', () => {
    expect(parseOpManifest('delete-text: 3')).toMatchObject({ kind: 'invalid' })
    expect(parseOpManifest('delete-text: 3, ""')).toMatchObject({ kind: 'invalid' })
  })
  it('treats backtick-wrapped no-change markers as no-change (matches isNoChangeMarker)', () => {
    // The model may echo the marker wrapped in backticks (the prompt quotes it);
    // this must be no-change, not an invalid prose fallback.
    expect(parseOpManifest('`<<NO_CHANGE>>`')).toEqual({ kind: 'no-change' })
    expect(parseOpManifest('``<<NO_CHANGE>>``')).toEqual({ kind: 'no-change' })
  })
})

describe('validateOpManifest', () => {
  it('accepts a balanced manifest and returns it unchanged', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const manifest: OpManifest = { deletes: [seqs[0]!], rewrites: new Map(), summarizes: [] }
    const result = validateOpManifest(manifest, seqs, s)
    expect(result).toMatchObject({ kind: 'ok' })
    if (result.kind === 'ok') expect(result.manifest).toEqual(manifest)
  })
  it('rejects seqs outside the chunk', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    expect(validateOpManifest({ deletes: [999_999], rewrites: new Map(), summarizes: [] }, seqs, s))
      .toMatchObject({ kind: 'invalid', reason: expect.stringContaining('not in this chunk') })
  })
  it('dedupes repeated references to the same seq within one operation', () => {
    // Real model output repeats an operation line (e.g. rewrite: 7369 twice);
    // that must be idempotent, not an overlap rejection.
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const manifest: OpManifest = {
      deletes: [seqs[0]!, seqs[0]!],
      rewrites: new Map(),
      summarizes: [],
    }
    const v = validateOpManifest(manifest, seqs, s)
    expect(v.kind).toBe('ok')
    if (v.kind === 'ok') expect(v.manifest.deletes).toEqual([seqs[0]!])
  })
  it('resolves cross-operation overlap conservatively (more content preserved wins)', () => {
    // delete + rewrite on the same seq: keep the rewrite (node stays, content
    // edited) and drop the delete. delete-text + delete: keep the precise
    // fragment deletion, drop the whole-node delete.
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const target = seqs[0]!
    const mixed: OpManifest = {
      deletes: [target],
      rewrites: new Map([[target, 'edited']]),
      summarizes: [],
    }
    const v1 = validateOpManifest(mixed, seqs, s)
    expect(v1.kind).toBe('ok')
    if (v1.kind === 'ok') {
      expect(v1.manifest.rewrites.get(target)).toBe('edited')
      expect(v1.manifest.deletes).toEqual([])
    }
    const textMixed: OpManifest = {
      deletes: [target],
      rewrites: new Map(),
      summarizes: [],
      deleteTexts: [{ seq: target, fragment: 'first' }],
    }
    const v2 = validateOpManifest(textMixed, seqs, s)
    expect(v2.kind).toBe('ok')
    if (v2.kind === 'ok') {
      expect(v2.manifest.deleteTexts).toEqual([{ seq: target, fragment: 'first' }])
      expect(v2.manifest.deletes).toEqual([])
    }
  })
  it('extends a one-sided delete to the whole tool pair (no fallback)', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    // seqs: [user1, assistant1, user2, call, result, user3, assistant3]
    const call = seqs[3]!
    const result = seqs[4]!
    const r1 = validateOpManifest({ deletes: [result], rewrites: new Map(), summarizes: [] }, seqs, s)
    expect(r1.kind).toBe('ok')
    if (r1.kind === 'ok') expect(new Set(r1.manifest.deletes)).toEqual(new Set([call, result]))
    const r2 = validateOpManifest({ deletes: [call], rewrites: new Map(), summarizes: [] }, seqs, s)
    expect(r2.kind).toBe('ok')
    if (r2.kind === 'ok') expect(new Set(r2.manifest.deletes)).toEqual(new Set([call, result]))
  })
  it('rewrites a tool-result node without pair-balance rejection (content-level edit)', () => {
    // "delete a little telemetry INSIDE a tool result" must be a rewrite of
    // that node — the node stays, so the call/result structure is intact and
    // pair balance must NOT reject it (a partial delete must not delete the
    // whole node, let alone its call).
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const result = seqs[4]!
    const manifest: OpManifest = { deletes: [], rewrites: new Map([[result, 'result without telemetry']]), summarizes: [] }
    const v = validateOpManifest(manifest, seqs, s)
    expect(v.kind).toBe('ok')
    if (v.kind === 'ok') expect(v.manifest.rewrites.get(result)).toBe('result without telemetry')
  })
  it('extends a rewrite of a tool-call node to delete its paired result', () => {
    // Rewriting a node that carries tool calls replaces the WHOLE node (its
    // text AND its calls); the paired results then have no matching call, so
    // the rewrite automatically extends them into deletes — no fallback.
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const call = seqs[3]!
    const result = seqs[4]!
    const manifest: OpManifest = { deletes: [], rewrites: new Map([[call, 'replaced text']]), summarizes: [] }
    const v = validateOpManifest(manifest, seqs, s)
    expect(v.kind).toBe('ok')
    if (v.kind === 'ok') {
      expect(v.manifest.rewrites.get(call)).toBe('replaced text')
      expect(new Set(v.manifest.deletes)).toEqual(new Set([result]))
    }
  })
  it('rejects a rewrite of a tool-call node whose result is also rewritten (conflict)', () => {
    // rewrite call + rewrite result: the call's extension wants the result
    // deleted while the model wants it kept-and-changed — contradictory.
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const call = seqs[3]!
    const result = seqs[4]!
    const manifest: OpManifest = {
      deletes: [],
      rewrites: new Map([[call, 'a'], [result, 'b']]),
      summarizes: [],
    }
    expect(validateOpManifest(manifest, seqs, s))
      .toMatchObject({ kind: 'invalid', reason: expect.stringContaining('conflict') })
  })
  it('rejects a delete whose pair extension collides with a rewrite of the paired node', () => {
    // Model: `delete: <call>` + `rewrite: <result>` (keep the result but
    // change its content). The delete extension would pull the result into
    // deletes, silently discarding the rewrite — this must be rejected, not
    // silently executed.
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const call = seqs[3]!
    const result = seqs[4]!
    const manifest: OpManifest = {
      deletes: [call],
      rewrites: new Map([[result, 'new result content']]),
      summarizes: [],
    }
    expect(validateOpManifest(manifest, seqs, s))
      .toMatchObject({ kind: 'invalid', reason: expect.stringContaining('conflict') })
  })
  it('drops an inflated rewrite (content > 1.1x the original) and keeps the node verbatim', () => {
    // Real no-change run: rewrites claimed "full content minus X" but output
    // MORE than the original, inflating the checkpoint past shrink. A rewrite
    // larger than 1.1x its original is treated as model expansion, not
    // deletion: the rewrite is dropped and the node stays verbatim.
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const target = seqs[1]! // assistant 'first answer' (short original)
    const manifest: OpManifest = {
      deletes: [], rewrites: new Map([[target, 'x'.repeat(1000)]]), summarizes: [],
    }
    const v = validateOpManifest(manifest, seqs, s)
    expect(v.kind).toBe('ok')
    if (v.kind === 'ok') expect(v.manifest.rewrites.has(target)).toBe(false)
  })
  it('keeps a rewrite not larger than 1.1x the original', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const target = seqs[1]!
    const manifest: OpManifest = {
      deletes: [], rewrites: new Map([[target, 'first answer']]), summarizes: [],
    }
    const v = validateOpManifest(manifest, seqs, s)
    expect(v.kind).toBe('ok')
    if (v.kind === 'ok') expect(v.manifest.rewrites.get(target)).toBe('first answer')
  })
  it('extends a one-sided summarize range to cover the paired node', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const call = seqs[3]!
    const result = seqs[4]!
    const manifest: OpManifest = {
      deletes: [], rewrites: new Map(),
      summarizes: [{ start: result, end: result, summary: 'x' }],
    }
    const v = validateOpManifest(manifest, seqs, s)
    expect(v.kind).toBe('ok')
    if (v.kind === 'ok') {
      expect(v.manifest.summarizes[0]!.start).toBe(call)
      expect(v.manifest.summarizes[0]!.end).toBe(result)
    }
  })
  it('rejects a summarize range whose boundary seqs are missing or inverted', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    expect(validateOpManifest({
      deletes: [], rewrites: new Map(),
      summarizes: [{ start: seqs[1]!, end: 999_999, summary: 'x' }],
    }, seqs, s)).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('not in this chunk') })
    expect(validateOpManifest({
      deletes: [], rewrites: new Map(),
      summarizes: [{ start: seqs[3]!, end: seqs[1]!, summary: 'x' }],
    }, seqs, s)).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('inverted') })
  })
  it('accepts a delete-text whose fragment exists in the node', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const manifest: OpManifest = {
      deletes: [], rewrites: new Map(), summarizes: [],
      deleteTexts: [{ seq: seqs[0]!, fragment: 'first' }], // 'first task'
    }
    const v = validateOpManifest(manifest, seqs, s)
    expect(v.kind).toBe('ok')
    if (v.kind === 'ok') expect(v.manifest.deleteTexts).toEqual([{ seq: seqs[0]!, fragment: 'first' }])
  })
  it('accepts a fragment with leading indentation (model copies numbered-render indents)', () => {
    // Real run (chunk 2 seq 850): the model copied "  53: | ..." with the
    // numbered render's continuation indent; the renderSpan baseline has no
    // indent. Leading whitespace is normalized before matching.
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const manifest: OpManifest = {
      deletes: [], rewrites: new Map(), summarizes: [],
      deleteTexts: [{ seq: seqs[0]!, fragment: '  first' }], // indent + 'first task'
    }
    const v = validateOpManifest(manifest, seqs, s)
    expect(v.kind).toBe('ok')
    if (v.kind === 'ok') expect(v.manifest.deleteTexts).toEqual([{ seq: seqs[0]!, fragment: '  first' }])
  })
  it('matches an indented backslash-literal fragment (indent + \\\\ combined, real seq-635 shape)', () => {
    // Real run (chunk 1 seq 635): the fragment carried BOTH a leading indent
    // (numbered-render continuation) AND literal double backslashes (tool
    // output escapes Windows paths). The two fixes must compose.
    const s = Session.create(SessionId('op-indent-backslash'))
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'docs\\\\subsystems\\\\x.md here' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const seqs = s.surface.nodes
    const manifest: OpManifest = {
      deletes: [], rewrites: new Map(), summarizes: [],
      deleteTexts: [{ seq: seqs[0]!, fragment: '  docs\\\\subsystems\\\\x.md' }],
    }
    const v = validateOpManifest(manifest, seqs, s)
    expect(v.kind).toBe('ok')
    if (v.kind !== 'ok') return
    expect(v.manifest.deleteTexts).toHaveLength(1)
    const out = executeOpManifest(v.manifest, seqs, s)
    expect(out).toContain(' here') // fragment removed, rest verbatim
    expect(out).not.toContain('docs\\\\subsystems\\\\x.md')
  })
  it('drops a delete-text whose fragment does not appear in the node (conservative)', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const manifest: OpManifest = {
      deletes: [], rewrites: new Map(), summarizes: [],
      deleteTexts: [{ seq: seqs[0]!, fragment: 'no such text' }],
    }
    const v = validateOpManifest(manifest, seqs, s)
    expect(v.kind).toBe('ok')
    if (v.kind === 'ok') expect(v.manifest.deleteTexts ?? []).toEqual([])
  })
  it('rejects a delete-text seq outside the chunk', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    expect(validateOpManifest({
      deletes: [], rewrites: new Map(), summarizes: [],
      deleteTexts: [{ seq: 999_999, fragment: 'x' }],
    }, seqs, s)).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('not in this chunk') })
  })
})

describe('executeOpManifest', () => {
  it('splices everything verbatim for a null (no-change) manifest', () => {
    const s = fixtureSession()
    const out = executeOpManifest(null, s.surface.nodes, s)
    expect(out).toContain('[user] first task')
    expect(out).toContain('[user] third task')
  })
  it('deletes a fragment inside a node and keeps the rest verbatim', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const manifest: OpManifest = {
      deletes: [], rewrites: new Map(), summarizes: [],
      deleteTexts: [{ seq: seqs[0]!, fragment: 'first' }], // '[user] first task'
    }
    const out = executeOpManifest(manifest, seqs, s)
    expect(out).toContain('[user]  task') // fragment removed, rest verbatim
    expect(out).not.toContain('[user] first')
    expect(out).toContain('[user] third task')
  })
  it('removes EVERY occurrence of the fragment', () => {
    const s = fixtureSession()
    const seqs = s.surface.nodes
    const manifest: OpManifest = {
      deletes: [], rewrites: new Map(), summarizes: [],
      deleteTexts: [{ seq: seqs[0]!, fragment: 't' }], // 'first task' has two 't's
    }
    const out = executeOpManifest(manifest, seqs, s)
    expect(out).toContain('[user] firs ask') // both 't's gone ('first'→'firs', 'task'→'ask')
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
