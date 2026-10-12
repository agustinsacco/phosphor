import { expect, it } from 'vitest'
import { emptyChatSession, type ToolState } from './chatItems'
import { currentWork } from './currentWork'
import { parseFleetWidget } from './subagentRuns'
import fixture from './__fixtures__/subagent-workflow.json'

const tool = (patch: Partial<ToolState> = {}): ToolState => ({
  toolCallId: 'fg',
  toolName: 'subagent',
  argsText: '',
  args: { agent: 'reviewer', task: 'Review' },
  status: 'running',
  startedAt: 1,
  output: {
    content: [],
    details: {
      runId: 'foreground',
      progress: [
        { index: 0, agent: 'reviewer', status: 'running', currentTool: 'read' },
        { index: 1, agent: 'scout', status: 'completed' },
      ],
    },
  },
  ...patch,
})
const fleet = () =>
  parseFleetWidget([`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(fixture.snapshot)}`])!
const chat = () => ({
  ...emptyChatSession(),
  isStreaming: true,
  agentStartedAt: 1,
  tools: { fg: tool() },
})

it('counts foreground children and background leaves without counting workflow roots', () => {
  const work = currentWork(chat(), fleet())
  expect(work.entries.reduce((n, entry) => n + entry.active, 0)).toBe(3)
  expect(work.entries.find((entry) => entry.toolCallId === 'fg')).toMatchObject({
    active: 1,
    currentTool: 'read',
  })
  expect(work.entries.filter((entry) => entry.active && entry.attention)).toHaveLength(1)
})
it('deduplicates a foreground-to-background handoff by native run ID', () => {
  const snapshot = fleet()
  const state = chat()
  state.tools.fg.output!.details = {
    runId: snapshot.runs[0]!.id,
    progress: [{ status: 'running' }],
  }
  expect(currentWork(state, snapshot).entries.some((entry) => entry.toolCallId)).toBe(false)
})
it('does not count management calls, detached launch receipts or idle replay as running', () => {
  for (const patch of [
    { args: { action: 'status' } },
    { args: { async: true, agent: 'worker' } },
  ]) {
    const state = chat()
    state.tools.fg = tool(patch)
    expect(currentWork(state, null).entries.every((entry) => entry.active === 0)).toBe(true)
  }
  expect(currentWork({ ...chat(), isStreaming: false }, null).entries[0]!.state).toBe(
    'status unavailable',
  )
})
it('retains vanished work as unknown, not active or accepted, and recovers on a fresh snapshot', () => {
  const snapshot = fleet()
  const remembered = { snapshot, receivedAt: 123 }
  const lost = currentWork(undefined, null, remembered)
  expect(lost.entries.filter((entry) => entry.state === 'status unavailable')).toHaveLength(2)
  expect(lost.entries.every((entry) => !entry.active && !entry.attention)).toBe(true)
  expect(lost.lastSeen).toBe(123)
  expect(currentWork(undefined, snapshot, remembered).entries.some((entry) => entry.active)).toBe(
    true,
  )
})
it('settles missing status only with exact native terminal evidence, not a same-named completion', () => {
  const snapshot = fleet()
  const state = emptyChatSession()
  state.items.push({
    id: 'n',
    kind: 'custom',
    customType: 'subagent-notify',
    text: 'worker finished',
    images: [],
    inContext: true,
    details: { runs: [{ runId: 'different', status: 'completed' }] },
  })
  expect(
    currentWork(state, null, { snapshot, receivedAt: 123 }).entries.some(
      (e) => e.state === 'status unavailable',
    ),
  ).toBe(true)
  state.items[0] = {
    ...state.items[0]!,
    kind: 'custom',
    text: 'worker finished',
    images: [],
    inContext: true,
    customType: 'subagent-notify',
    details: { runs: [{ runId: snapshot.runs[0]!.id, status: 'failed' }] },
  }
  expect(currentWork(state, null, { snapshot, receivedAt: 123 }).entries).toEqual([
    expect.objectContaining({ runId: snapshot.runs[0]!.id, state: 'failed', active: 0 }),
  ])
})
it('never revives an orphaned or replayed tool in a later parent turn', () => {
  expect(currentWork({ ...chat(), agentStartedAt: 2 }, null).entries[0]!.active).toBe(0)
  const state = chat()
  state.tools.fg = tool({ startedAt: undefined })
  expect(currentWork(state, null).entries[0]!.state).toBe('status unavailable')
})

it('does not infer success from an empty settled delegation or transport failure', () => {
  const state = chat()
  state.tools.fg = tool({ status: 'done', output: null })
  expect(currentWork(state, null).entries[0]!.state).toBe('status unavailable')
  expect(currentWork({ ...chat(), error: 'disconnected' }, null).entries[0]!.active).toBe(0)
})
