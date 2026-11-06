import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrainCapture } from '@phosphor/shared/brain'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import type { BrainMemoryClient } from './memory-client'
const authority = vi.hoisted(() => ({ scope: '/repo', branch: 'main' }))
vi.mock('./authority', async (original) => ({
  ...(await original<object>()),
  laneAuthority: async () => ({ ...authority }),
}))
import { attachBrainCapture } from './capture'

type Receipt = { complete(response: unknown): void | Promise<void> }
type Observer = (() => void) & {
  beforeInput?: (command: {
    type: 'prompt' | 'steer' | 'follow_up'
    message: string
  }) => Promise<Receipt | undefined>
}
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})
const entry = (id: string, text: string, parentId: string | null = null) => ({
  type: 'message',
  id,
  parentId,
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: text },
})
async function fixture(baselineSwitch = false) {
  authority.branch = 'main'
  const captures: BrainCapture[] = []
  const onError = vi.fn()
  let native = 'initial'
  let entries = [entry('baseline', 'old baseline')]
  let switchOnEntries = baselineSwitch
  const client = Object.assign(new EventEmitter(), {
    request: vi.fn(async (command: { type: string }) => {
      if (command.type === 'get_state') return { success: true, data: { sessionId: native } }
      if (switchOnEntries) {
        native = 'historical'
        entries = [entry('history', 'old historical text')]
      }
      return { success: true, data: { entries } }
    }),
  })
  const live = { sessionId: 'runtime', workspacePath: '/repo', client } as unknown as LiveSession
  const store = {
    snapshot: async () => ({ prefs: { enabled: true, workspaces: ['/repo'] }, policyEpoch: 1 }),
    captureAt: async (_epoch: number, input: BrainCapture) => {
      captures.push(input)
      return null
    },
  } as unknown as BrainMemoryClient
  const attach = async () => {
    const observer = (await attachBrainCapture(live, store, 1, onError)) as Observer
    cleanups.push(observer)
    return observer
  }
  return {
    client,
    captures,
    onError,
    attach,
    setEntries(value: typeof entries) {
      entries = value
    },
    switchOnEntries() {
      switchOnEntries = true
    },
  }
}
it('rejects a baseline assembled across native session identities', async () => {
  const f = await fixture(true)
  await expect(f.attach()).rejects.toThrow('identity')
})
it('discards a scan switched between get_state and get_entries before any capture', async () => {
  const f = await fixture()
  await f.attach()
  f.switchOnEntries()
  f.client.emit('event', { type: 'agent_end' })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.captures).toEqual([])
  expect(f.onError).toHaveBeenCalled()
})
it('uses trusted input-admission branch rather than a fast later checkout', async () => {
  const f = await fixture()
  const observer = await f.attach()
  const receipt = await observer.beforeInput?.({ type: 'prompt', message: 'admitted on main' })
  authority.branch = 'other'
  f.setEntries([entry('baseline', 'old baseline'), entry('new', 'admitted on main', 'baseline')])
  await receipt?.complete({
    type: 'response',
    command: 'prompt',
    success: true,
    data: { disposition: 'started' },
  })
  f.client.emit('event', { type: 'agent_start' })
  f.client.emit('event', { type: 'agent_end' })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.captures).toMatchObject([{ entryId: 'new', branch: 'main' }])
})
it('omits unadmitted and handled/generated user text', async () => {
  const f = await fixture()
  const observer = await f.attach()
  const receipt = await observer.beforeInput?.({ type: 'prompt', message: 'handled text' })
  f.setEntries([entry('baseline', 'old baseline'), entry('generated', 'handled text', 'baseline')])
  await receipt?.complete({
    type: 'response',
    command: 'prompt',
    success: true,
    data: { disposition: 'handled' },
  })
  f.client.emit('event', { type: 'agent_end' })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.captures).toEqual([])
})
it('preserves different queued admissions across branch changes without end-of-turn relabeling', async () => {
  const f = await fixture()
  const observer = await f.attach()
  const first = await observer.beforeInput?.({ type: 'prompt', message: 'first queue' })
  await first?.complete({
    type: 'response',
    command: 'prompt',
    success: true,
    data: { disposition: 'queued' },
  })
  authority.branch = 'second'
  const second = await observer.beforeInput?.({ type: 'prompt', message: 'second queue' })
  await second?.complete({
    type: 'response',
    command: 'prompt',
    success: true,
    data: { disposition: 'queued' },
  })
  authority.branch = 'end'
  f.setEntries([
    entry('baseline', 'old baseline'),
    entry('first', 'first queue', 'baseline'),
    entry('second', 'second queue', 'first'),
  ])
  f.client.emit('event', { type: 'agent_end' })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.captures).toMatchObject([
    { entryId: 'first', branch: 'main' },
    { entryId: 'second', branch: 'second' },
  ])
})
it('does not capture plain user entries without a trusted admission receipt', async () => {
  const f = await fixture()
  await f.attach()
  f.setEntries([
    entry('baseline', 'old baseline'),
    entry('unadmitted', 'extension authored text', 'baseline'),
  ])
  f.client.emit('event', { type: 'agent_end' })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.captures).toEqual([])
})
it('omits duplicate matching new entries rather than guessing which one the user admitted', async () => {
  const f = await fixture()
  const observer = await f.attach()
  const receipt = await observer.beforeInput?.({ type: 'prompt', message: 'ambiguous text' })
  f.setEntries([
    entry('baseline', 'old baseline'),
    entry('first', 'ambiguous text', 'baseline'),
    entry('second', 'ambiguous text', 'first'),
  ])
  await receipt?.complete({
    type: 'response',
    command: 'prompt',
    success: true,
    data: { disposition: 'started' },
  })
  expect(f.captures).toEqual([])
})
it.each([
  undefined,
  { success: false },
  { type: 'response', command: 'prompt', success: true },
  { type: 'response', command: 'steer', success: true, data: { disposition: 'started' } },
])('omits failed or ambiguous command responses: %j', async (response) => {
  const f = await fixture()
  const observer = await f.attach()
  const receipt = await observer.beforeInput?.({ type: 'prompt', message: 'not proven' })
  f.setEntries([entry('baseline', 'old baseline'), entry('new', 'not proven', 'baseline')])
  await receipt?.complete(response)
  expect(f.captures).toEqual([])
})
it('bounds pending queued admissions and disables capture visibly at capacity', async () => {
  const f = await fixture()
  const observer = await f.attach()
  for (let index = 0; index < 32; index++) {
    const receipt = await observer.beforeInput?.({ type: 'prompt', message: `queued-${index}` })
    await receipt?.complete({
      type: 'response',
      command: 'prompt',
      success: true,
      data: { disposition: 'queued' },
    })
  }
  await expect(observer.beforeInput?.({ type: 'prompt', message: 'overflow' })).rejects.toThrow(
    'budget',
  )
  expect(f.onError).toHaveBeenCalled()
  expect(f.client.listenerCount('event')).toBe(0)
})
it.each(['steer', 'follow_up'] as const)(
  'attributes a successful queued %s to its input-admission branch',
  async (type) => {
    const f = await fixture()
    const observer = await f.attach()
    const receipt = await observer.beforeInput?.({ type, message: 'queued user input' })
    await receipt?.complete({
      type: 'response',
      command: type,
      success: true,
      data: { disposition: 'queued' },
    })
    authority.branch = 'later'
    f.setEntries([
      entry('baseline', 'old baseline'),
      entry('queued', 'queued user input', 'baseline'),
    ])
    f.client.emit('event', { type: 'agent_end' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(f.captures).toMatchObject([{ entryId: 'queued', branch: 'main' }])
  },
)
