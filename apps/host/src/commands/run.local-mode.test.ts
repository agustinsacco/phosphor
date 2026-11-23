import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Runtime from '../session/runtime'
import type * as Routines from '../routines/service'
import { runHost } from './run'
import { localRunMachine } from './__fixtures__/run-local'

/** What run started and stopped, in order. */
const hooks = vi.hoisted(() => ({
  order: [] as string[],
  machine: null as Omit<Runtime.HostMachine, 'log'> | null,
}))
vi.mock('./doctor', () => ({
  inspectHost: vi.fn(async () => {
    hooks.order.push('inspect')
    return { machine: hooks.machine, secrets: [] }
  }),
}))
vi.mock('../api/server', () => ({
  startApi: () => {
    hooks.order.push('api')
    return {
      deliver: () => {},
      isConnected: () => false,
      stop: async () => {
        hooks.order.push('api.stop')
      },
    }
  },
}))
vi.mock('../session/runtime', async (original) => {
  const module = await original<typeof Runtime>()
  return {
    ...module,
    createHostRuntime: (...args: Parameters<typeof module.createHostRuntime>) => {
      hooks.order.push('runtime')
      const runtime = module.createHostRuntime(...args)
      const drain = runtime.drain.bind(runtime)
      runtime.drain = (reason) => {
        hooks.order.push('runtime.drain')
        return drain(reason)
      }
      return runtime
    },
  }
})
vi.mock('../routines/service', async (original) => {
  const module = await original<typeof Routines>()
  return {
    ...module,
    createHostRoutines: (...args: Parameters<typeof module.createHostRoutines>) => {
      const routines = module.createHostRoutines(...args)
      const start = routines.start.bind(routines)
      routines.start = () => {
        hooks.order.push('routines.start')
        start()
      }
      return routines
    },
  }
})
afterEach(() => {
  hooks.order = []
  hooks.machine = null
})

describe('run without the local-mode marker (characterization)', () => {
  it('exits 69 when unenrolled, before any network call or lane', async () => {
    const host = await localRunMachine({ enrolled: false, marker: false, heartbeat: 'accepted' })
    try {
      hooks.machine = host.machine
      expect(await runHost(host.context())).toBe(69)
      expect(host.control.output).toEqual(['Run phosphor setup first.'])
      expect(host.beats).toEqual([])
      expect(hooks.order).toEqual([])
    } finally {
      await host.cleanup()
    }
  })

  it('exits 77 on a 410 and drains its lanes', async () => {
    const host = await localRunMachine({ enrolled: true, marker: false, heartbeat: 'gone' })
    try {
      hooks.machine = host.machine
      expect(await runHost(host.context())).toBe(77)
      expect(host.beats).toEqual(['running'])
      expect(hooks.order).toEqual([
        'inspect',
        'runtime',
        'routines.start',
        'api',
        'api.stop',
        'runtime.drain',
      ])
    } finally {
      await host.cleanup()
    }
  })
})
