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

it('shows recorded prompt and request time without turning replayed tools live', () => {
  const state = chat()
  state.tools.fg.startedAt = undefined
  state.items.push({
    id: 'a',
    kind: 'assistant',
    timestamp: 100,
    streaming: false,
    blocks: [{ type: 'tool', index: 0, toolCallId: 'fg' }],
  })
  expect(currentWork(state, null).entries[0]).toMatchObject({
    task: 'Review',
    requestedAt: 100,
    active: 0,
  })
})
it('enriches exact root tasks but not their child steps', () => {
  const state = chat()
  const snapshot = fleet()
  state.tools.fg.output!.details = { runId: snapshot.runs[0]!.id }
  expect(currentWork(state, snapshot).entries.every((e) => !e.task)).toBe(true)
  snapshot.runs[0]!.children = []
  expect(currentWork(state, snapshot).entries[0]?.task).toBe('Review')
  snapshot.runs[0]!.startedAt = undefined
  expect(currentWork(state, snapshot).entries[0]).toMatchObject({
    requestedAt: 1,
    startedAt: undefined,
  })
  state.tools.fg.args!.async = true
  expect(currentWork(state, null).entries[0]).toMatchObject({
    requestedAt: 1,
    startedAt: undefined,
  })
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

const launch = (id: string, runId: string, args: Record<string, unknown>): ToolState => ({
  toolCallId: id,
  toolName: 'subagent',
  argsText: '',
  args: { async: true, ...args },
  status: 'done',
  startedAt: 5,
  endedAt: 6,
  output: null,
  result: { content: [], details: { asyncId: runId, background: true } },
})
const snapshotOf = (runs: unknown[]) =>
  parseFleetWidget([`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({ ...fixture.snapshot, runs })}`])!
const singleRun = (id: string, activity: Record<string, unknown> = {}) => ({
  id,
  kind: 'subagent',
  label: 'worker',
  state: 'running',
  startedAt: 10,
  children: [
    { id: 'step:0', kind: 'step', label: 'worker', state: 'running', startedAt: 11, activity },
  ],
})
const RUN_A = '6fd80dda-0000-4000-8000-000000000000'
const RUN_B = '02323497-0000-4000-8000-000000000000'
const preamble = 'You are a worker in this repository. Follow the house rules.\n'

it('shows a single-agent run once, routed to its step, with the launch prompt', () => {
  const state = {
    ...emptyChatSession(),
    tools: { a: launch('a', RUN_A, { agent: 'worker', task: `${preamble}Write desktop.md` }) },
  }
  const { entries } = currentWork(
    state,
    snapshotOf([
      singleRun(RUN_A, {
        currentTool: 'bash',
        currentToolStartedAt: 20,
        toolCount: 4,
        turnCount: 2,
        lastActivityAt: 21,
      }),
    ]),
  )
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({
    runId: RUN_A,
    childId: 'step:0',
    single: true,
    state: 'running',
    active: 1,
    task: `${preamble}Write desktop.md`,
    startedAt: 11,
    currentTool: 'bash',
    currentToolStartedAt: 20,
    toolCount: 4,
    turnCount: 2,
    lastActivityAt: 21,
  })
})

it('titles parallel workers by what tells their prompts apart, never by agent name', () => {
  const state = {
    ...emptyChatSession(),
    tools: {
      a: launch('a', RUN_A, { agent: 'worker', task: `${preamble}Write /repo/briefs/desktop.md` }),
      b: launch('b', RUN_B, { agent: 'worker', task: `${preamble}Write /repo/briefs/remote.md` }),
    },
  }
  const { entries } = currentWork(state, snapshotOf([singleRun(RUN_A), singleRun(RUN_B)]))
  expect(entries.map((e) => [e.runId, e.title])).toEqual([
    [RUN_A, 'Write desktop.md'],
    [RUN_B, 'Write remote.md'],
  ])
})

it('gives each parallel step its own prompt by native index, and a chain with groups none', () => {
  const parallel = {
    id: RUN_A,
    kind: 'subagent',
    label: 'scout, reviewer',
    state: 'running',
    children: [
      { id: 'step:0', kind: 'step', label: 'scout', state: 'running' },
      { id: 'step:1', kind: 'step', label: 'reviewer', state: 'queued' },
    ],
  }
  const tasks = [
    { agent: 'scout', task: 'Map the code' },
    { agent: 'reviewer', task: 'Review the map' },
  ]
  const state = { ...emptyChatSession(), tools: { a: launch('a', RUN_A, { tasks }) } }
  const { entries } = currentWork(state, snapshotOf([parallel]))
  expect(entries.map((e) => [e.childId, e.task, e.group?.id, e.single])).toEqual([
    ['step:0', 'Map the code', RUN_A, undefined],
    ['step:1', 'Review the map', RUN_A, undefined],
  ])
  state.tools.a = launch('a', RUN_A, { chain: [{ parallel: tasks }, ...tasks] })
  expect(currentWork(state, snapshotOf([parallel])).entries.every((e) => !e.task)).toBe(true)
})

it('keeps a vanished single run as one unknown row, not two', () => {
  const remembered = { snapshot: snapshotOf([singleRun(RUN_A)]), receivedAt: 50 }
  const { entries } = currentWork(emptyChatSession(), snapshotOf([]), remembered)
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({
    childId: 'step:0',
    single: true,
    state: 'status unavailable',
    active: 0,
  })
})

it('titles a call that names several tasks by their count, not a borrowed prompt', () => {
  const state = chat()
  state.tools.fg.args = {
    tasks: [
      { agent: 'scout', task: 'Map' },
      { agent: 'worker', task: 'Fix' },
    ],
  }
  expect(currentWork(state, null).entries[0]).toMatchObject({
    label: 'scout, worker',
    task: undefined,
    title: '2 delegated tasks',
  })
})

it("lets a single run's own state win over its step", () => {
  const state = (root: string, step: string) => {
    const run = singleRun(RUN_A)
    run.state = root
    run.children[0]!.state = step
    return currentWork(emptyChatSession(), snapshotOf([run])).entries[0]
  }
  expect(state('running', 'complete')).toMatchObject({ state: 'running', active: 1 })
  expect(state('running', 'queued')).toMatchObject({ state: 'queued', active: 1 })
  expect(state('failed', 'running')).toMatchObject({ state: 'failed', active: 0 })
  expect(state('complete', 'complete')).toMatchObject({ state: 'complete', active: 0 })
})

it('keeps a title when its agent finishes and a sibling is still running', () => {
  const state = {
    ...emptyChatSession(),
    tools: {
      a: launch('a', RUN_A, { agent: 'worker', task: `${preamble}Write desktop.md` }),
      b: launch('b', RUN_B, { agent: 'worker', task: `${preamble}Write remote.md` }),
    },
  }
  const done = singleRun(RUN_B)
  done.state = 'complete'
  done.children[0]!.state = 'complete'
  const { entries } = currentWork(state, snapshotOf([singleRun(RUN_A), done]))
  expect(entries.map((e) => [e.active, e.title])).toEqual([
    [1, 'Write desktop.md'],
    [0, 'Write remote.md'],
  ])
})

it('marks a coordinating workflow as its own group and a detached solo launch as single', () => {
  const workflow = structuredClone(fixture.snapshot.runs[0]!)
  workflow.children.forEach((child) => (child.state = 'complete'))
  const { entries } = currentWork(emptyChatSession(), snapshotOf([workflow]))
  const root = entries.find((e) => !e.childId)!
  expect(root).toMatchObject({ active: 1, group: { id: workflow.id } })
  expect(entries.filter((e) => e.childId).every((e) => e.group?.id === workflow.id)).toBe(true)
  const detached = currentWork(
    { ...emptyChatSession(), tools: { a: launch('a', RUN_A, { agent: 'worker', task: 'Map' }) } },
    null,
  ).entries[0]
  expect(detached).toMatchObject({ runId: RUN_A, single: true, state: 'status unavailable' })
  expect(detached?.childId).toBeUndefined()
})
