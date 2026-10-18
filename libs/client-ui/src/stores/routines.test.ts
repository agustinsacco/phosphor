import { expect, it, vi, afterEach } from 'vitest'
import { newRoutine, type Routine, type RoutinesSnapshot } from '@shared/routines'
import { useRoutinesStore } from './routines'

const local: Routine = {
  ...newRoutine('/local'),
  id: 'local',
  name: 'Local task',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  nextAt: null,
  attention: null,
  archived: false,
}
afterEach(() => {
  vi.unstubAllGlobals()
  useRoutinesStore.setState({ snapshot: null, machines: [], remote: {}, error: null })
})
it('publishes local routines without waiting for two machines, isolates failure and ignores stale refreshes', async () => {
  const machines = ['bee1', 'bee2'].map((label) => ({
    id: `host:${label}`,
    label,
    available: true,
    control: true,
    repositories: [],
  }))
  let release: (value: RoutinesSnapshot) => void = () => {}
  const slow = new Promise<RoutinesSnapshot>((resolve) => {
    release = resolve
  })
  const invoke = vi.fn(async (_channel: string, machine?: string) => {
    if (machine === 'host:bee1') return slow
    if (machine === 'host:bee2') throw new Error('secret machine path')
    return { routines: [local], runs: [], background: false, error: null, machines }
  })
  vi.stubGlobal('window', { phosphor: { invoke } })
  await useRoutinesStore.getState().refresh()
  expect(useRoutinesStore.getState().snapshot?.routines).toEqual([local])
  expect(useRoutinesStore.getState().error).toBeNull()
  await Promise.resolve()
  await Promise.resolve()
  expect(useRoutinesStore.getState().remote['host:bee2']?.unavailable).toBe(true)
  release({
    routines: [{ ...local, id: 'host:bee1/task' }],
    runs: [],
    background: false,
    error: null,
  })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(useRoutinesStore.getState().remote['host:bee1']?.routines[0]?.id).toBe('host:bee1/task')
  expect(useRoutinesStore.getState().snapshot?.routines).toEqual([local])
  expect(useRoutinesStore.getState().error).toBeNull()
})

it('ignores remote replies from a superseded local refresh', async () => {
  let release: (value: RoutinesSnapshot) => void = () => {}
  const slow = new Promise<RoutinesSnapshot>((resolve) => {
    release = resolve
  })
  let first = true
  vi.stubGlobal('window', {
    phosphor: {
      invoke: async (_channel: string, machine?: string) => {
        if (machine) return slow
        const machines = first
          ? [{ id: 'host:old', label: 'old', available: true, control: true, repositories: [] }]
          : []
        first = false
        return { routines: [local], runs: [], background: false, error: null, machines }
      },
    },
  })
  await useRoutinesStore.getState().refresh()
  await useRoutinesStore.getState().refresh()
  release({
    routines: [{ ...local, id: 'host:old/task' }],
    runs: [],
    background: false,
    error: null,
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(useRoutinesStore.getState().remote).toEqual({})
  expect(useRoutinesStore.getState().snapshot?.routines).toEqual([local])
})

it('ignores a late reply replaced by a newer refresh of the same machine', async () => {
  const machine = {
    id: 'host:bee1',
    label: 'bee1',
    available: true,
    control: true,
    repositories: [],
  }
  let release: (value: RoutinesSnapshot) => void = () => {}
  const slow = new Promise<RoutinesSnapshot>((resolve) => {
    release = resolve
  })
  let count = 0
  vi.stubGlobal('window', {
    phosphor: {
      invoke: async (_channel: string, target?: string) => {
        if (!target)
          return {
            routines: [local],
            runs: [],
            background: false,
            error: null,
            machines: [machine],
          }
        if (++count === 1) return slow
        return { routines: [{ ...local, id: 'new' }], runs: [], background: false, error: null }
      },
    },
  })
  await useRoutinesStore.getState().refresh()
  await useRoutinesStore.getState().refreshMachine(machine.id)
  release({ routines: [{ ...local, id: 'old' }], runs: [], background: false, error: null })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(useRoutinesStore.getState().remote[machine.id]?.routines[0]?.id).toBe('new')
})

it('does not restart slow machine reads for unchanged directory notifications', async () => {
  const machine = {
    id: 'host:bee1',
    label: 'bee1',
    available: true,
    control: true,
    repositories: [],
  }
  let release: (value: RoutinesSnapshot) => void = () => {}
  const slow = new Promise<RoutinesSnapshot>((resolve) => {
    release = resolve
  })
  const invoke = vi.fn(async (_channel: string, target?: string) =>
    target
      ? slow
      : { routines: [local], runs: [], background: false, error: null, machines: [machine] },
  )
  vi.stubGlobal('window', { phosphor: { invoke } })
  await useRoutinesStore.getState().refresh()
  await useRoutinesStore.getState().refreshConnections()
  await useRoutinesStore.getState().refreshConnections()
  expect(invoke.mock.calls.filter(([, target]) => target === machine.id)).toHaveLength(1)
  release({ routines: [{ ...local, id: 'slow' }], runs: [], background: false, error: null })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(useRoutinesStore.getState().remote[machine.id]?.routines[0]?.id).toBe('slow')
})

it('keeps an available machine’s routines through a refresh until its read settles', async () => {
  const machine = {
    id: 'host:bee1',
    label: 'bee1',
    available: true,
    control: true,
    repositories: [],
  }
  let available = true
  const reads: Array<(value: RoutinesSnapshot) => void> = []
  vi.stubGlobal('window', {
    phosphor: {
      invoke: async (_channel: string, target?: string) => {
        if (target) return new Promise<RoutinesSnapshot>((resolve) => reads.push(resolve))
        const machines = [{ ...machine, available }]
        return { routines: [local], runs: [], background: false, error: null, machines }
      },
    },
  })
  const settle = async (id: string) => {
    reads.shift()?.({ routines: [{ ...local, id }], runs: [], background: false, error: null })
    for (let i = 0; i < 3; i++) await Promise.resolve()
  }
  await useRoutinesStore.getState().refresh()
  await settle('host:bee1/task')
  await useRoutinesStore.getState().refresh()
  expect(useRoutinesStore.getState().remote[machine.id]).toEqual({
    routines: [expect.objectContaining({ id: 'host:bee1/task' })],
    unavailable: false,
  })
  await settle('host:bee1/next')
  expect(useRoutinesStore.getState().remote[machine.id]?.routines[0]?.id).toBe('host:bee1/next')
  available = false
  await useRoutinesStore.getState().refresh()
  expect(useRoutinesStore.getState().remote[machine.id]).toEqual({
    routines: [],
    unavailable: true,
  })
})
