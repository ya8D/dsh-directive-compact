import { describe, expect, it } from 'vitest'
import {
  headBoundaryIndex,
  isInjectedSystemNode,
  isUserUtterance,
  planCompaction,
  splitTurns,
  type PlanConfig,
  type SurfaceNodeInfo,
} from '../src/plan.ts'

/** Build a surface node descriptor. */
function node(seq: number, type: SurfaceNodeInfo['type'], kind: string = type): SurfaceNodeInfo {
  return { seq, type, kind }
}

/** The fixed-skeleton head: fresh session opening. */
function freshHead(start: number): SurfaceNodeInfo[] {
  return [
    node(start, 'user/message', 'user'),
    node(start + 1, 'user/message', 'agent-instructions'),
    node(start + 2, 'user/message', '@deepseek-ai/dsh-system-prompt'),
    node(start + 3, 'user/message', 'skill-catalog'),
  ]
}

/** One full user turn: user utterance, one assistant reply, one tool result. */
function userTurn(start: number): SurfaceNodeInfo[] {
  return [
    node(start, 'user/message', 'user'),
    node(start + 1, 'assistant/message'),
    node(start + 2, 'tool/result'),
  ]
}

/** N full user turns starting at `start`, each 10 nodes apart for readable seqs. */
function userTurns(start: number, count: number): SurfaceNodeInfo[] {
  const out: SurfaceNodeInfo[] = []
  for (let i = 0; i < count; i += 1) out.push(...userTurn(start + i * 10))
  return out
}

const DEFAULT: PlanConfig = { keepHeadUsers: 3, keepTailUsers: 3 }

describe('isUserUtterance', () => {
  it('accepts a genuine user message', () => {
    expect(isUserUtterance(node(1, 'user/message', 'user'))).toBe(true)
  })
  it('rejects injected system nodes', () => {
    expect(isUserUtterance(node(1, 'user/message', 'agent-instructions'))).toBe(false)
    expect(isUserUtterance(node(1, 'user/message', 'skill-catalog'))).toBe(false)
    expect(isUserUtterance(node(1, 'user/message', 'compact'))).toBe(false)
  })
  it('rejects non-user message types', () => {
    expect(isUserUtterance(node(1, 'assistant/message'))).toBe(false)
    expect(isUserUtterance(node(1, 'tool/result'))).toBe(false)
  })
})

describe('isInjectedSystemNode', () => {
  it('accepts every non-user-sourced user/message', () => {
    expect(isInjectedSystemNode(node(1, 'user/message', 'agent-instructions'))).toBe(true)
    expect(isInjectedSystemNode(node(1, 'user/message', '@deepseek-ai/dsh-system-prompt'))).toBe(true)
    expect(isInjectedSystemNode(node(1, 'user/message', 'skill-catalog'))).toBe(true)
    expect(isInjectedSystemNode(node(1, 'user/message', 'compact'))).toBe(true)
  })
  it('rejects a genuine user message', () => {
    expect(isInjectedSystemNode(node(1, 'user/message', 'user'))).toBe(false)
  })
  it('rejects non-user message types', () => {
    expect(isInjectedSystemNode(node(1, 'assistant/message'))).toBe(false)
    expect(isInjectedSystemNode(node(1, 'tool/result'))).toBe(false)
  })
})

describe('headBoundaryIndex', () => {
  it('returns 0 (the first user index) in a fresh session', () => {
    const nodes = [...freshHead(0), ...userTurn(10)]
    expect(headBoundaryIndex(nodes)).toBe(0)
  })
  it('returns nodes.length when no user utterance exists', () => {
    expect(headBoundaryIndex([node(1, 'assistant/message')])).toBe(1)
    expect(headBoundaryIndex([])).toBe(0)
  })
  it('returns the user index after a leading compact checkpoint and injections', () => {
    const nodes = [
      node(0, 'user/message', 'compact'),
      node(1, 'user/message', 'agent-instructions'),
      node(2, 'user/message', '@deepseek-ai/dsh-system-prompt'),
      node(3, 'user/message', 'skill-catalog'),
      node(4, 'user/message', 'user'),
    ]
    expect(headBoundaryIndex(nodes)).toBe(4)
  })
  it('returns 0 when the user utterance leads and injections follow it', () => {
    const nodes = [
      node(0, 'user/message', 'user'),
      node(1, 'user/message', 'skill-catalog'),
      node(2, 'assistant/message'),
    ]
    expect(headBoundaryIndex(nodes)).toBe(0)
  })
})

describe('splitTurns', () => {
  it('splits conversation into user-led turns', () => {
    const conversation = [...userTurn(10), ...userTurn(20)]
    const turns = splitTurns(conversation)
    expect(turns).toEqual([[0, 1, 2], [3, 4, 5]])
  })
  it('starts a turn on a leading non-user node', () => {
    const conversation = [node(1, 'assistant/message'), node(2, 'tool/result')]
    expect(splitTurns(conversation)).toEqual([[0, 1]])
  })
  it('keeps tool results with their assistant message', () => {
    const conversation = [
      node(0, 'user/message', 'user'),
      node(1, 'assistant/message'),
      node(2, 'tool/result'),
      node(3, 'assistant/message'),
      node(4, 'tool/result'),
    ]
    expect(splitTurns(conversation)).toEqual([[0, 1, 2, 3, 4]])
  })
})

describe('planCompaction', () => {
  it('returns none for a surface with only the skeleton and no user turn', () => {
    // freshHead: user0 + 3 injections, but no assistant/tool content.
    expect(planCompaction(freshHead(0), DEFAULT).kind).toBe('none')
  })

  it('returns none when the user count is at most head+tail budgets', () => {
    // freshHead contributes 1 anchor; 5 userTurns → 6 anchors = 3 head + 3 tail, nothing left.
    const nodes = [...freshHead(0), ...userTurns(100, 5)]
    expect(planCompaction(nodes, DEFAULT).kind).toBe('none')
    // 4 userTurns → 5 anchors likewise.
    const nodes4 = [...freshHead(0), ...userTurns(100, 4)]
    expect(planCompaction(nodes4, DEFAULT).kind).toBe('none')
  })

  it('primary: 7 userTurns (8 anchors) keeps head(3) + middle(2) + tail(3)', () => {
    const nodes = [...freshHead(0), ...userTurns(100, 7)]
    const plan = planCompaction(nodes, DEFAULT)
    expect(plan.kind).toBe('primary')
    if (plan.kind !== 'primary') return
    // Head = user0 + injections + user1/user2 turns (0..3, 100..112);
    // middle = user3/user4 turns (120..132); tail = user5-7 turns (140..162).
    expect(plan.headSeqs).toEqual([0, 1, 2, 3, 100, 101, 102, 110, 111, 112])
    expect(plan.middleSeqs).toEqual([120, 121, 122, 130, 131, 132])
    expect(plan.tailSeqs).toEqual([140, 141, 142, 150, 151, 152, 160, 161, 162])
  })

  it('primary: 10 userTurns (11 anchors) keeps head(3) + middle(5) + tail(3)', () => {
    const nodes = [...freshHead(0), ...userTurns(100, 10)]
    const plan = planCompaction(nodes, DEFAULT)
    expect(plan.kind).toBe('primary')
    if (plan.kind !== 'primary') return
    // Head = user0 + injections + user1/user2 (0..3, 100..112);
    // middle = user3-7 (120..162); tail = user8-10 (170..192).
    expect(plan.headSeqs).toEqual([0, 1, 2, 3, 100, 101, 102, 110, 111, 112])
    expect(plan.middleSeqs).toEqual([120, 121, 122, 130, 131, 132, 140, 141, 142, 150, 151, 152, 160, 161, 162])
    expect(plan.tailSeqs).toEqual([170, 171, 172, 180, 181, 182, 190, 191, 192])
  })

  it('primary: tail keeps an in-flight assistant stream after the last kept user', () => {
    // 7 userTurns (8 anchors) + an extra unclosed assistant after the last turn.
    const nodes = [
      ...freshHead(0),
      ...userTurns(100, 7),
      node(200, 'assistant/message'), // in-flight, no tool result yet
    ]
    const plan = planCompaction(nodes, DEFAULT)
    expect(plan.kind).toBe('primary')
    if (plan.kind !== 'primary') return
    expect(plan.headSeqs).toEqual([0, 1, 2, 3, 100, 101, 102, 110, 111, 112])
    expect(plan.middleSeqs).toEqual([120, 121, 122, 130, 131, 132])
    expect(plan.tailSeqs).toEqual([140, 141, 142, 150, 151, 152, 160, 161, 162, 200])
  })

  it('primary: configurable budgets keep 1 head and 1 tail user', () => {
    const config: PlanConfig = { keepHeadUsers: 1, keepTailUsers: 1 }
    // freshHead (1 anchor) + 3 userTurns → 4 anchors: head=u0, middle=u1/u2, tail=u3.
    const nodes = [...freshHead(0), ...userTurns(100, 3)]
    const plan = planCompaction(nodes, config)
    expect(plan.kind).toBe('primary')
    if (plan.kind !== 'primary') return
    // Head = user0 + its injections (0..3); middle = user1/user2 (100..112);
    // tail = user3 turn (120..122).
    expect(plan.headSeqs).toEqual([0, 1, 2, 3])
    expect(plan.middleSeqs).toEqual([100, 101, 102, 110, 111, 112])
    expect(plan.tailSeqs).toEqual([120, 121, 122])
  })

  it('primary: a compact checkpoint in the surface folds into the head and anchors stay correct', () => {
    // Simulate a prior compaction: checkpoint node (kind=compact) precedes the
    // injected nodes and the real user turns. The skeleton absorbs it; anchors
    // are the genuine user utterances after it (compact is not an anchor).
    const nodes = [
      node(0, 'user/message', 'compact'), // prior checkpoint
      node(1, 'user/message', 'agent-instructions'),
      node(2, 'user/message', '@deepseek-ai/dsh-system-prompt'),
      node(3, 'user/message', 'skill-catalog'),
      ...userTurns(100, 7),
    ]
    const plan = planCompaction(nodes, DEFAULT)
    expect(plan.kind).toBe('primary')
    if (plan.kind !== 'primary') return
    // Skeleton (0..3) + user0-2 turns (100..122); middle = user3 turn (130..132);
    // tail = user4-6 (140..162).
    expect(plan.headSeqs).toEqual([0, 1, 2, 3, 100, 101, 102, 110, 111, 112, 120, 121, 122])
    expect(plan.middleSeqs).toEqual([130, 131, 132])
    expect(plan.tailSeqs).toEqual([140, 141, 142, 150, 151, 152, 160, 161, 162])
  })

  it('none: no user utterance in the conversation', () => {
    const nodes = [
      node(0, 'user/message', 'agent-instructions'),
      node(1, 'assistant/message'),
      node(2, 'tool/result'),
    ]
    expect(planCompaction(nodes, DEFAULT).kind).toBe('none')
  })

  it('none: empty surface', () => {
    expect(planCompaction([], DEFAULT).kind).toBe('none')
  })
})
