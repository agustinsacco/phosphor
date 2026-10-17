import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { controlMachine, type ControlMachine } from '../control/__fixtures__/machine'
import { fakeMachine, EXTENSIONS_ROOT } from '../__fixtures__/machine'
import { buildPiEnvironment } from '../machine/environment'
import { identityDirectory } from '../control/identity'
import { createShutdown, type Drainable } from '../shutdown'
import { readdirSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import { inspectHost } from './doctor'
import { runHost, type RunContext } from './run'
import type * as Runtime from '../session/runtime'
import type * as Store from '../lanes/store'
import type { LaneService } from '../lanes/service'
import type * as Skills from '../features/skills'
import type * as Naming from '../lanes/naming'
import type * as Commands from '../lanes/commands'
import type * as Native from '../terminals/native'
import type * as Terminals from '../terminals/service'
import type * as Attachments from '../features/attachments'
import type * as Routines from '../routines/service'
import type * as Live from '../lanes/live'
import type * as Lock from '../control/lock'

const sink = vi.hoisted(() => ({ deliver: vi.fn(), isConnected: vi.fn(() => true) }))
const hooks = vi.hoisted(
  (): {
    machine: Omit<Runtime.HostMachine, 'log'> | null
    order: string[]
    lanes: LaneService | undefined
    epoch: string
    connected?: (id: string) => boolean
    dialogs?: 'cancel' | 'forward'
    skillsConfigPath?: string
  } => ({ machine: null, order: [], lanes: undefined, epoch: '' }),
)
// Teardown calls record their phase in hooks.order through `step`.
const teardown = vi.hoisted(() => {
  const state = {
    native: null as Native.HostPtyModule | null,
    /** Each wrapped teardown call reports here first. A test may swap it to throw, hold or reject. */
    step: (name: string): Promise<void> | void => {
      hooks.order.push(name)
    },
    /** A synchronous teardown call. A step that throws stops it, as the real call would. */
    now(name: string, original: () => void) {
      void state.step(name)
      original()
    },
    /** An asynchronous one. The original runs once the step's promise, if any, resolves. */
    later<T>(name: string, original: () => Promise<T>): Promise<T> {
      const held = state.step(name)
      return held ? held.then(original) : original()
    },
  }
  return state
})
const recordStep = teardown.step
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
      stop: () => teardown.later('api', async () => {}),
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
        drain: (...args: Parameters<typeof runtime.drain>) =>
          teardown.later('runtime', () => runtime.drain(...args)),
      }
    },
  }
})
vi.mock('../features/skills', async (original) => {
  const module = await original<typeof Skills>()
  return {
    ...module,
    createSkillsFeature: (...args: Parameters<typeof module.createSkillsFeature>) => {
      hooks.skillsConfigPath = args[1]?.configPath
      return module.createSkillsFeature(...args)
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
      vi.spyOn(store, 'close').mockImplementation(() => teardown.now('store', close))
      return store
    },
  }
})
vi.mock('../lanes/naming', async (original) => {
  const module = await original<typeof Naming>()
  return {
    ...module,
    createLaneNamer: (...args: Parameters<typeof module.createLaneNamer>) => {
      const namer = module.createLaneNamer(...args)
      const cancel = namer.cancel.bind(namer)
      namer.cancel = () => teardown.now('naming', cancel)
      return namer
    },
  }
})
vi.mock('../lanes/commands', async (original) => {
  const module = await original<typeof Commands>()
  return {
    ...module,
    createLaneCommands: (...args: Parameters<typeof module.createLaneCommands>) => {
      const commands = module.createLaneCommands(...args)
      const close = commands.close.bind(commands)
      commands.close = () => teardown.later('commands', close)
      return commands
    },
  }
})
vi.mock('../terminals/native', async (original) => ({
  ...(await original<typeof Native>()),
  loadHostPty: () => teardown.native,
}))
vi.mock('../terminals/service', async (original) => {
  const module = await original<typeof Terminals>()
  return {
    ...module,
    createTerminals: (...args: Parameters<typeof module.createTerminals>) => {
      const terminals = module.createTerminals(...args)
      const close = terminals.close.bind(terminals)
      terminals.close = () => teardown.now('terminals', close)
      return terminals
    },
  }
})
vi.mock('../features/attachments', async (original) => {
  const module = await original<typeof Attachments>()
  return {
    ...module,
    createAttachments: (...args: Parameters<typeof module.createAttachments>) => {
      const attachments = module.createAttachments(...args)
      const close = attachments.close.bind(attachments)
      attachments.close = () => teardown.now('attachments', close)
      return attachments
    },
  }
})
vi.mock('../routines/service', async (original) => {
  const module = await original<typeof Routines>()
  return {
    ...module,
    createHostRoutines: (...args: Parameters<typeof module.createHostRoutines>) => {
      const routines = module.createHostRoutines(...args)
      const stop = routines.stop.bind(routines)
      const close = routines.close.bind(routines)
      routines.stop = () => teardown.later('routines.stop', stop)
      routines.close = () => teardown.later('routines.close', close)
      return routines
    },
  }
})
vi.mock('../lanes/live', async (original) => {
  const module = await original<typeof Live>()
  return {
    ...module,
    createLiveLanes: (...args: Parameters<typeof module.createLiveLanes>) => {
      const live = module.createLiveLanes(...args)
      const close = live.close.bind(live)
      live.close = () => teardown.now('live', close)
      return live
    },
  }
})
vi.mock('../control/lock', async (original) => {
  const module = await original<typeof Lock>()
  return {
    ...module,
    acquireIdentityLock: async (...args: Parameters<typeof module.acquireIdentityLock>) => {
      const release = await module.acquireIdentityLock(...args)
      return args[3] === '.run-lock' ? () => teardown.later('release', release) : release
    },
  }
})
afterEach(() => {
  sink.deliver.mockClear()
  sink.isConnected.mockClear()
  hooks.machine = null
  hooks.order = []
  hooks.lanes = undefined
  hooks.skillsConfigPath = undefined
  teardown.step = recordStep
  teardown.native = null
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
          // A custom --config must reach the machine reads, not the default path.
          expect(hooks.skillsConfigPath).toBe(control.context.configPath)
          expect(hooks.lanes?.epoch).toBe(hooks.epoch)
          expect(hooks.lanes?.capabilities).toEqual([
            'sessions.read',
            'sessions.control',
            'workspaces.write',
            'routines',
            'workspaces.read',
            'skills.read',
            'artifacts.read',
          ])
          for (const method of ['artifacts.list', 'artifacts.read'])
            expect(hooks.lanes?.calls.capabilityFor(method)).toBe('artifacts.read')
          for (const method of ['routines.list', 'routines.history'])
            expect(hooks.lanes?.calls.capabilityFor(method)).toBe('routines')
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

/** Every teardown phase of a fully started Host, in the order run takes them. */
const PHASES = [
  'naming',
  'api',
  'routines.stop',
  'runtime',
  'commands',
  'terminals',
  'attachments',
  'routines.close',
  'live',
  'store',
  'release',
]
/** An enrolled Host whose machine and native PTY are usable, so every teardown phase exists. */
async function fullHost() {
  const control = await controlMachine()
  const pi = fakeMachine({ rpc: true })
  await control.enrollOld()
  vi.stubEnv('PATH', process.env.PATH)
  vi.stubEnv('PI_CODING_AGENT_DIR', pi.agentDir)
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  const environment = buildPiEnvironment({
    hostEnv: pi.hostEnv,
    nodePath: process.execPath,
    platform: process.platform,
  })
  hooks.machine = {
    pi: { binaryPath: process.execPath, prefixArgs: [pi.cli] },
    env: environment.env,
    roots: [pi.repository],
    resourceRoot: EXTENSIONS_ROOT,
    contextBudget: '',
  }
  teardown.native = { spawn: vi.fn() }
  const context: RunContext = {
    ...control.context,
    env: { XDG_STATE_HOME: join(control.root, 'state'), PI_CODING_AGENT_DIR: pi.agentDir },
    home: pi.home,
    nodeVersion: process.versions.node,
    defaultResourceRoot: EXTENSIONS_ROOT,
    heartbeat: {
      readiness: async () => ({ pi: 'ok', claude: 'ok', tailscale: 'ok' }),
      random: () => 0,
      seq: { read: async () => 0, write: async () => {} },
    },
    fetch: async () => Response.json({ accepted: true, nextInSec: 30 }),
  }
  return {
    control,
    context,
    cleanup: async () => {
      await control.cleanup()
      pi.cleanup()
    },
  }
}
async function runLocks(control: ControlMachine) {
  return (await readdir(identityDirectory(control.configPath))).filter((name) =>
    name.startsWith('.run-lock'),
  )
}
describe('run teardown', () => {
  it('closes every phase once in dependency order and releases the run lock', async () => {
    const host = await fullHost()
    try {
      const result = await runHost({
        ...host.context,
        wait: async () => {
          host.control.abort.abort()
        },
      })
      expect(result, host.control.output.join('\n')).toBe(0)
      expect(hooks.lanes?.capabilities).toContain('terminal')
      expect(hooks.order).toEqual(PHASES)
      expect(await runLocks(host.control)).toEqual([])
    } finally {
      await host.cleanup()
    }
  })
  it('shares the stops a signal began, and a repeat drain closes and releases nothing again', async () => {
    const host = await fullHost()
    let target: Drainable | undefined
    let signalled = false
    let drained: Promise<{ state: 'stopped' | 'failed' }> | undefined
    try {
      const result = await runHost({
        ...host.context,
        attach: (drain) => {
          target = drain
          return () => {}
        },
        wait: async (_ms, signal) => {
          // The heartbeat's own drain waits here too, before `drained` is assigned.
          if (signal?.aborted || signalled) return
          signalled = true
          drained = target?.drain('SIGTERM')
        },
      })
      expect(result, host.control.output.join('\n')).toBe(0)
      expect(await drained).toEqual({ state: 'stopped' })
      expect(hooks.order).toEqual([
        'naming',
        'api',
        'routines.stop',
        'runtime',
        'naming',
        'api',
        ...PHASES.slice(4),
      ])
      expect(await runLocks(host.control)).toEqual([])
      const before = hooks.order.length
      expect(await target?.drain('SIGTERM')).toEqual({ state: 'stopped' })
      expect(hooks.order.slice(before)).toEqual(['naming', 'api', 'runtime'])
      expect(target?.exitCode?.('SIGTERM', true)).toBe(143)
    } finally {
      await host.cleanup()
    }
  })
})
describe('run teardown failures', () => {
  /** Fails `phase` the first time it is reached: synchronously, or as a rejected promise. */
  function fail(phase: string, mode: 'throw' | 'reject', error: Error) {
    let failed = false
    teardown.step = (name) => {
      hooks.order.push(name)
      if (name !== phase || failed) return
      failed = true
      if (mode === 'throw') throw error
      return Promise.reject(error)
    }
  }
  const ASYNC_PHASES = ['api', 'routines.stop', 'runtime', 'commands', 'routines.close', 'release']
  it.each([
    ...PHASES.map((phase) => ({ phase, mode: 'throw' as const })),
    ...ASYNC_PHASES.map((phase) => ({ phase, mode: 'reject' as const })),
  ])(
    'attempts every phase once when $phase fails ($mode), then rejects with it and exits 70',
    async ({ phase, mode }) => {
      const host = await fullHost()
      const failure = new Error(`${phase} failed`)
      const log = vi.fn()
      fail(phase, mode, failure)
      try {
        await expect(
          runHost({
            ...host.context,
            log,
            wait: async () => {
              host.control.abort.abort()
            },
          }),
        ).rejects.toBe(failure)
        expect(hooks.order).toEqual(PHASES)
        expect(log).toHaveBeenCalledWith(
          'host',
          'end',
          expect.objectContaining({ command: 'run', exitCode: 70 }),
        )
        // Only a failed release leaves its lock behind.
        expect(await runLocks(host.control)).toEqual(phase === 'release' ? ['.run-lock'] : [])
      } finally {
        await host.cleanup()
      }
    },
  )
  it('keeps the first failure when a later phase fails too', async () => {
    const host = await fullHost()
    const first = new Error('commands failed')
    teardown.step = (name) => {
      hooks.order.push(name)
      if (name === 'commands') return Promise.reject(first)
      if (name === 'store') throw new Error('store failed')
    }
    try {
      await expect(
        runHost({
          ...host.context,
          wait: async () => {
            host.control.abort.abort()
          },
        }),
      ).rejects.toBe(first)
      expect(hooks.order).toEqual(PHASES)
      expect(await runLocks(host.control)).toEqual([])
    } finally {
      await host.cleanup()
    }
  })
  it('closes nothing until every stop has settled, even after one has failed', async () => {
    const host = await fullHost()
    const failure = new Error('api failed')
    let finish: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      finish = resolve
    })
    teardown.step = (name) => {
      hooks.order.push(name)
      if (name === 'api') return Promise.reject(failure)
      if (name === 'runtime') return held
    }
    try {
      const outcome = runHost({
        ...host.context,
        wait: async () => {
          host.control.abort.abort()
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      await vi.waitFor(() => expect(hooks.order).toContain('runtime'))
      await setTimeout(50)
      // The runtime still drains: neither the store nor the run lock may go yet.
      expect(hooks.order).toEqual(PHASES.slice(0, 4))
      finish()
      expect(await outcome).toBe(failure)
      expect(hooks.order).toEqual(PHASES)
    } finally {
      await host.cleanup()
    }
  })
  it('closes what a failed start-up opened, even when one close fails', async () => {
    const host = await fullHost()
    const failure = new Error('attachments failed')
    let target: Drainable | undefined
    vi.mocked(inspectHost).mockRejectedValueOnce(new Error('inspection failed'))
    fail('attachments', 'throw', failure)
    try {
      await expect(
        runHost({
          ...host.context,
          attach: (drain) => {
            target = drain
            return () => {}
          },
        }),
      ).rejects.toBe(failure)
      expect(hooks.order).toEqual(['attachments', 'store', 'release'])
      expect(target?.exitCode?.('SIGTERM', true)).toBe(70)
      expect(await runLocks(host.control)).toEqual([])
    } finally {
      await host.cleanup()
    }
  })
  it.each(['throw', 'reject'] as const)(
    'a signal whose stop fails (%s) still waits for the release, then exits 70',
    async (mode) => {
      const host = await fullHost()
      const exits: number[] = []
      const atExit: string[][] = []
      const shutdown = createShutdown({
        exit: (code) => {
          exits.push(code)
          atExit.push(
            readdirSync(identityDirectory(host.control.configPath)).filter((name) =>
              name.startsWith('.run-lock'),
            ),
          )
        },
        stderr: () => {},
        stopProbes: () => {},
      })
      fail('api', mode, new Error('api failed'))
      let signalled = false
      let stopping: Promise<void> | undefined
      try {
        const result = await runHost({
          ...host.context,
          attach: shutdown.attach,
          wait: async (ms) => {
            // 5 s is the stopping beat's own wait.
            if (ms === 5000) return
            // A drain that gave up early leaves the loop running: end it.
            if (signalled) return host.control.abort.abort()
            signalled = true
            stopping = shutdown.signal('SIGTERM')
          },
        })
        await stopping
        expect(result).toBe(0)
        expect(exits).toEqual([70])
        expect(atExit).toEqual([[]])
        expect(hooks.order.filter((step) => step === 'release')).toHaveLength(1)
      } finally {
        await host.cleanup()
      }
    },
  )
})
