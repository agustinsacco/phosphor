import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { controlMachine } from '../control/__fixtures__/machine'
import { fakeMachine, EXTENSIONS_ROOT } from '../__fixtures__/machine'
import { buildPiEnvironment } from '../machine/environment'
import type { Drainable } from '../shutdown'
import { runHost } from './run'
import type * as Runtime from '../session/runtime'
import type * as Store from '../lanes/store'
import type { LaneService } from '../lanes/service'

const sink = vi.hoisted(() => ({ deliver: vi.fn(), isConnected: vi.fn(() => true) }))
const hooks = vi.hoisted(
  (): {
    machine: Omit<Runtime.HostMachine, 'log'> | null
    order: string[]
    lanes: LaneService | undefined
    epoch: string
    connected?: (id: string) => boolean
    dialogs?: 'cancel' | 'forward'
  } => ({ machine: null, order: [], lanes: undefined, epoch: '' }),
)
vi.mock('./doctor', () => ({
  inspectHost: vi.fn(async () => ({ machine: hooks.machine, secrets: [] })),
}))
vi.mock('../api/server', () => ({
  startApi: (options: { runtimeEpoch: string; lanes?: LaneService }) => {
    hooks.lanes = options.lanes
    hooks.epoch = options.runtimeEpoch
    return {
      ready: Promise.resolve(),
      deliver: sink.deliver,
      isConnected: sink.isConnected,
      stop: async () => {
        hooks.order.push('api')
      },
    }
  },
}))
vi.mock('../session/runtime', async (original) => {
  const module = await original<typeof Runtime>()
  return {
    ...module,
    createHostRuntime: (...args: Parameters<typeof module.createHostRuntime>) => {
      hooks.dialogs = args[1]?.dialogs
      const runtime = module.createHostRuntime(...args)
      return {
        ...runtime,
        drain: (...args: Parameters<typeof runtime.drain>) => {
          hooks.order.push('runtime')
          return runtime.drain(...args)
        },
      }
    },
  }
})
vi.mock('../lanes/store', async (original) => {
  const module = await original<typeof Store>()
  return {
    ...module,
    openStore: async (...args: Parameters<typeof module.openStore>) => {
      const store = await module.openStore(...args)
      hooks.connected = args[2]?.isConnected
      const close = store.close.bind(store)
      vi.spyOn(store, 'close').mockImplementation(() => {
        hooks.order.push('store')
        close()
      })
      return store
    },
  }
})
afterEach(() => {
  sink.deliver.mockClear()
  sink.isConnected.mockClear()
  hooks.machine = null
  hooks.order = []
  hooks.lanes = undefined
  vi.unstubAllEnvs()
})
describe('run lane composition', () => {
  it.each([
    { available: false, second: false },
    { available: true, second: false },
    { available: true, second: true },
  ])(
    'keeps heartbeat/auth alive with $available, second signal $second and drains in order',
    async ({ available, second }) => {
      const control = await controlMachine()
      const pi = fakeMachine({ rpc: true })
      try {
        await control.enrollOld()
        vi.stubEnv('PATH', process.env.PATH)
        vi.stubEnv('PI_CODING_AGENT_DIR', pi.agentDir)
        vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
        const environment = buildPiEnvironment({
          hostEnv: pi.hostEnv,
          nodePath: process.execPath,
          platform: process.platform,
        })
        if (available)
          hooks.machine = {
            pi: { binaryPath: process.execPath, prefixArgs: [pi.cli] },
            env: environment.env,
            roots: [pi.repository],
            resourceRoot: EXTENSIONS_ROOT,
            contextBudget: '',
          }
        let target: Drainable | undefined
        const log = vi.fn()
        let failedExit: number | undefined
        let forcedCount = 0
        let connected = false
        const result = await runHost({
          ...control.context,
          env: { XDG_STATE_HOME: join(control.root, 'state'), PI_CODING_AGENT_DIR: pi.agentDir },
          home: pi.home,
          nodeVersion: process.versions.node,
          defaultResourceRoot: EXTENSIONS_ROOT,
          log,
          attach: (drain) => {
            target = drain
            return () => {}
          },
          heartbeat: {
            readiness: async () => ({ pi: 'ok', claude: 'ok', tailscale: 'ok' }),
            random: () => 0,
            seq: { read: async () => 0, write: async () => {} },
          },
          fetch: async () => Response.json({ accepted: true, nextInSec: 30 }),
          wait: async (_ms, signal) => {
            if (signal?.aborted) return
            if (hooks.order.includes('api')) return new Promise(() => {})
            connected = hooks.connected?.('client') ?? false
            hooks.lanes?.commands.status(
              '12345678-1234-4234-8234-123456789012',
              '12345678-1234-4234-8234-123456789012',
              '0123456789abcdef',
            )
            failedExit = target?.exitCode?.('SIGTERM', false)
            const draining = target?.drain('SIGTERM')
            let forced: Promise<unknown> | undefined
            if (second) {
              forced = target?.drain('SIGINT')
              forcedCount = hooks.order.filter((step) => step === 'runtime').length
            }
            await Promise.all([draining, forced])
          },
        })
        expect(result, control.output.join('\n')).toBe(0)
        expect(hooks.epoch).toMatch(/^[a-f0-9]{16}$/)
        expect(failedExit).toBe(70)
        expect(connected).toBe(true)
        expect(sink.isConnected).toHaveBeenCalledWith('client')
        if (available) {
          expect(sink.deliver).toHaveBeenCalledWith(
            '12345678-1234-4234-8234-123456789012',
            { requestId: '12345678-1234-4234-8234-123456789012', status: 'unknown' },
            '0123456789abcdef',
          )
          expect(hooks.dialogs).toBe('forward')
          expect(hooks.lanes?.epoch).toBe(hooks.epoch)
          expect(hooks.lanes?.capabilities).toEqual([
            'sessions.read',
            'sessions.control',
            'workspaces.read',
            'skills.read',
            'artifacts.read',
          ])
          for (const method of ['artifacts.list', 'artifacts.read'])
            expect(hooks.lanes?.calls.capabilityFor(method)).toBe('artifacts.read')
          for (const method of ['files.list', 'files.read', 'git.status', 'git.diff', 'git.show'])
            expect(hooks.lanes?.calls.capabilityFor(method)).toBe('workspaces.read')
          for (const method of [
            'machine.models',
            'machine.providers',
            'skills.list',
            'skills.read',
          ])
            expect(hooks.lanes?.calls.capabilityFor(method)).toBe('skills.read')
          expect(hooks.lanes?.streams.cursor('12345678-1234-4234-8234-123456789012').epoch).toBe(
            hooks.epoch,
          )
        } else {
          expect(hooks.lanes).toBeUndefined()
          expect(log).toHaveBeenCalledWith('host', 'lanes.unavailable', {
            reason: 'machine-unusable',
          })
        }
        if (second) expect(forcedCount).toBe(2)

        const api = hooks.order.indexOf('api'),
          store = hooks.order.indexOf('store')
        expect(api).toBeGreaterThanOrEqual(0)
        expect(store).toBeGreaterThan(api)
        if (available) {
          const runtime = hooks.order.indexOf('runtime')
          expect(runtime).toBeGreaterThan(api)
          expect(store).toBeGreaterThan(runtime)
          expect(hooks.order.filter((step) => step === 'runtime')).toHaveLength(second ? 2 : 1)
        }
      } finally {
        await control.cleanup()
        pi.cleanup()
      }
    },
  )
})
