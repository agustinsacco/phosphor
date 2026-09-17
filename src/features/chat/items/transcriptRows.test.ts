import { describe, expect, it } from 'vitest'
import {
  activeActivityId,
  buildTranscriptRows,
  isActivityLive,
  summarizeActivity,
  type ActivityStep,
} from './transcriptRows'
import { settledVerb } from '../tools/toolSummaries'
import type { AssistantBlock, AssistantItem, ChatItem, ToolState } from '../reducer'

let seq = 0
const nextId = (): string => `i${++seq}`

const thinking = (index: number, closed = true): AssistantBlock => ({
  type: 'thinking',
  index,
  text: 'hmm',
  closed,
})
const text = (index: number, t = 'prose', closed = true): AssistantBlock => ({
  type: 'text',
  index,
  text: t,
  closed,
})
const tool = (index: number, id: string): AssistantBlock => ({
  type: 'tool',
  index,
  toolCallId: id,
})

const assistant = (
  blocks: AssistantBlock[],
  extra: Partial<AssistantItem> = {},
): AssistantItem => ({
  id: nextId(),
  kind: 'assistant',
  blocks,
  streaming: false,
  ...extra,
})

const user = (t = 'hi'): ChatItem => ({ id: nextId(), kind: 'user', text: t })

const toolState = (id: string, name: string, status: ToolState['status'] = 'done'): ToolState => ({
  toolCallId: id,
  toolName: name,
  argsText: '',
  status,
  output: null,
})

describe('activeActivityId', () => {
  it('keeps the latest activity active between settled tools while the agent runs', () => {
    const rows = buildTranscriptRows([
      assistant([thinking(0), tool(1, 'c1')]),
      assistant([], { streaming: true }),
    ])
    const activity = rows.find((row) => row.kind === 'activity')
    expect(activity?.kind).toBe('activity')
    expect(activeActivityId(rows, true)).toBe(activity?.id)
  })

  it('ends the active group when final response prose starts', () => {
    const rows = buildTranscriptRows([
      assistant([tool(0, 'c1')]),
      assistant([text(0, 'Final answer')], { streaming: true }),
    ])
    expect(activeActivityId(rows, true)).toBeNull()
  })

  it('has no active group after the agent ends', () => {
    const rows = buildTranscriptRows([assistant([tool(0, 'c1')])])
    expect(activeActivityId(rows, false)).toBeNull()
  })
})

describe('buildTranscriptRows', () => {
  it('merges activity across pi’s one-tool-per-message boundary', () => {
    // The real shape: 4 separate assistant messages, each [thinking, toolCall].
    const items = [
      user('check if there is a pr up'),
      assistant([thinking(0), tool(1, 'c1')]),
      assistant([thinking(0), tool(1, 'c2')]),
      assistant([thinking(0), tool(1, 'c3')]),
      assistant([thinking(0), text(1, 'Yes, there is an open PR.')]),
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.map((r) => r.kind)).toEqual(['item', 'activity', 'text'])
    const activity = rows[1]
    if (activity?.kind !== 'activity') throw new Error('expected activity')
    // 3 thinking + 3 tools from three messages, plus the 4th message's thinking.
    expect(activity.steps).toHaveLength(7)
    expect(activity.steps.filter((s) => s.block.type === 'tool')).toHaveLength(3)
  })

  it('splits activity at prose and user boundaries', () => {
    const items = [
      assistant([tool(0, 'c1')]),
      assistant([text(0, 'midway')]),
      assistant([tool(0, 'c2')]),
      user('next question'),
      assistant([tool(0, 'c3')]),
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.map((r) => r.kind)).toEqual(['activity', 'text', 'activity', 'item', 'activity'])
  })

  it('keeps non-assistant items as their own rows, in order', () => {
    const bash: ChatItem = {
      id: nextId(),
      kind: 'bash',
      command: 'ls',
      output: '',
      exitCode: 0,
      running: false,
      truncated: false,
    }
    const divider: ChatItem = { id: nextId(), kind: 'divider', variant: 'compaction' }
    const rows = buildTranscriptRows([user(), assistant([tool(0, 'c1')]), bash, divider])
    expect(rows.map((r) => r.kind)).toEqual(['item', 'activity', 'item', 'item'])
  })

  it('does not merge across an interleaved bash item', () => {
    const bash: ChatItem = {
      id: nextId(),
      kind: 'bash',
      command: 'ls',
      output: '',
      exitCode: 0,
      running: false,
      truncated: false,
    }
    const rows = buildTranscriptRows([assistant([tool(0, 'a')]), bash, assistant([tool(0, 'b')])])
    expect(rows.map((r) => r.kind)).toEqual(['activity', 'item', 'activity'])
  })

  it('emits an outcome row for errors and aborts, after content', () => {
    const failed = assistant([text(0, 'partial')], { stopReason: 'error', errorMessage: 'boom' })
    const rows = buildTranscriptRows([failed])
    expect(rows.map((r) => r.kind)).toEqual(['text', 'outcome'])
  })

  it('gives an empty streaming turn a row to hang the spinner on', () => {
    const rows = buildTranscriptRows([assistant([], { streaming: true })])
    expect(rows.map((r) => r.kind)).toEqual(['item'])
  })

  it('produces stable unique row ids', () => {
    const rows = buildTranscriptRows([
      user(),
      assistant([thinking(0), tool(1, 'c1'), text(2, 'done')]),
    ])
    const ids = rows.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('marks the last block of a message for streaming-tail detection', () => {
    const item = assistant([text(0, 'a'), text(1, 'b')], { streaming: true })
    const rows = buildTranscriptRows([item])
    const flags = rows.map((r) => (r.kind === 'text' ? r.isLastInItem : null))
    expect(flags).toEqual([false, true])
  })
})

describe('isActivityLive', () => {
  const step = (block: AssistantBlock, streaming = false, isLast = true): ActivityStep => ({
    itemId: 'i1',
    block: block as ActivityStep['block'],
    streaming,
    isLastInItem: isLast,
  })

  it('is live while a tool is running or starting', () => {
    const tools = { c1: toolState('c1', 'bash', 'running') }
    expect(isActivityLive([step(tool(0, 'c1'))], tools)).toBe(true)
    expect(isActivityLive([step(tool(0, 'c1'))], { c1: toolState('c1', 'bash', 'done') })).toBe(
      false,
    )
  })

  it('is live while the trailing thinking block is still open', () => {
    expect(isActivityLive([step(thinking(0, false), true, true)], {})).toBe(true)
    expect(isActivityLive([step(thinking(0, true), true, true)], {})).toBe(false)
  })

  it('is settled when an errored tool finished', () => {
    expect(isActivityLive([step(tool(0, 'c1'))], { c1: toolState('c1', 'bash', 'error') })).toBe(
      false,
    )
  })
})

describe('summarizeActivity', () => {
  const mkSteps = (ids: Array<[string, string]>, thinkingCount = 0): ActivityStep[] => {
    const steps: ActivityStep[] = []
    for (let i = 0; i < thinkingCount; i++) {
      steps.push({
        itemId: 'i',
        block: thinking(i) as ActivityStep['block'],
        streaming: false,
        isLastInItem: false,
      })
    }
    ids.forEach(([id], i) => {
      steps.push({
        itemId: 'i',
        block: tool(i + thinkingCount, id) as ActivityStep['block'],
        streaming: false,
        isLastInItem: false,
      })
    })
    return steps
  }

  const toolsFor = (ids: Array<[string, string]>): Record<string, ToolState> =>
    Object.fromEntries(ids.map(([id, name]) => [id, toolState(id, name)]))

  const labelFor = (t: ToolState): string => settledVerb(t.toolName)

  it('counts by verb rather than listing every call', () => {
    const ids: Array<[string, string]> = [
      ['a', 'edit'],
      ['b', 'edit'],
      ['c', 'bash'],
      ['d', 'read'],
      ['e', 'read'],
      ['f', 'read'],
    ]
    const s = summarizeActivity(mkSteps(ids, 1), toolsFor(ids), labelFor)
    expect(s.stepLabel).toBe('7 steps')
    expect(s.detail).toBe('edited 2 files, ran 1 command, read 3 files')
    expect(s.thinkingCount).toBe(1)
  })

  it('uses singular nouns for a single call', () => {
    const ids: Array<[string, string]> = [['a', 'bash']]
    const s = summarizeActivity(mkSteps(ids), toolsFor(ids), labelFor)
    expect(s.stepLabel).toBe('1 step')
    expect(s.detail).toBe('ran 1 command')
  })

  it('counts failures for the collapsed badge', () => {
    const ids: Array<[string, string]> = [
      ['a', 'bash'],
      ['b', 'bash'],
    ]
    const tools = toolsFor(ids)
    tools.a = toolState('a', 'bash', 'error')
    const s = summarizeActivity(mkSteps(ids), tools, labelFor)
    expect(s.failedCount).toBe(1)
  })

  it('is tense-stable: a running tool counts with its settled siblings', () => {
    const ids: Array<[string, string]> = [
      ['a', 'read'],
      ['b', 'read'],
    ]
    const tools = toolsFor(ids)
    tools.b = toolState('b', 'read', 'running')
    const s = summarizeActivity(mkSteps(ids), tools, labelFor)
    expect(s.detail).toBe('read 2 files')
  })

  it('names artifact tools properly (they used to summarize as "used 1 tool")', () => {
    const ids: Array<[string, string]> = [
      ['a', 'artifact_create'],
      ['b', 'artifact_update'],
    ]
    const s = summarizeActivity(mkSteps(ids), toolsFor(ids), labelFor)
    expect(s.detail).toBe('created 1 artifact, updated 1 artifact')
  })

  it('handles a thinking-only group', () => {
    const s = summarizeActivity(mkSteps([], 2), {}, labelFor)
    expect(s.stepLabel).toBe('2 steps')
    expect(s.detail).toBe('')
    expect(s.thinkingCount).toBe(2)
  })
})

describe('compact marker (the CLI compacted its own session)', () => {
  const marker =
    '[Claude Code · compact {"trigger":"auto","preTokens":360561,"postTokens":37239,"durationMs":166547}]'

  it('draws a compaction divider between the activity before and after, never a tool row', () => {
    const rows = buildTranscriptRows([
      assistant([thinking(0), text(1, marker), thinking(2), text(3, 'done')]),
    ])
    expect(rows.map((r) => r.kind)).toEqual(['activity', 'item', 'activity', 'text'])
    const divider = rows[1]!
    if (divider.kind !== 'item') throw new Error('expected an item row')
    expect(divider.item).toMatchObject({
      kind: 'divider',
      variant: 'compaction',
      tokensBefore: 360561,
      reason: 'threshold',
    })
    expect((divider.item as { summary?: string }).summary).toContain('compacted its own session')
  })

  it('reads a manual /compact as manual and survives a payload it cannot parse', () => {
    const rows = buildTranscriptRows([
      assistant([
        text(0, '[Claude Code · compact {"trigger":"manual","preTokens":1000,"postTokens":100}]'),
        text(1, '[Claude Code · compact not-json]'),
      ]),
    ])
    expect(rows).toHaveLength(2)
    const [manual, blind] = rows
    if (manual?.kind !== 'item' || blind?.kind !== 'item') throw new Error('expected item rows')
    expect(manual.item).toMatchObject({
      variant: 'compaction',
      reason: 'manual',
      tokensBefore: 1000,
    })
    expect(blind.item).toMatchObject({ variant: 'compaction', reason: 'threshold' })
    expect((blind.item as { tokensBefore?: number }).tokensBefore).toBeUndefined()
  })

  it('gives each divider a stable, distinct row id', () => {
    const rows = buildTranscriptRows([assistant([text(0, marker), text(1, marker)])])
    const ids = rows.map((r) => r.id)
    expect(new Set(ids).size).toBe(2)
  })
})
