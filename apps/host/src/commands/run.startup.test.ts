import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { controlMachine } from '../control/__fixtures__/machine'
import { fakeMachine, EXTENSIONS_ROOT } from '../__fixtures__/machine'
import { buildPiEnvironment } from '../machine/environment'
import { loadHostConfig } from '../config/load'
import { reconcile } from '../lanes/reconcile'
import { runHost } from './run'
import type * as Runtime from '../session/runtime'
import type * as Store from '../lanes/store'
import type * as Attachments from '../features/attachments'
import type * as LiveHost from '../lanes/live-host'
import type * as Routines from '../routines/service'
import type * as Naming from '../lanes/naming'
import type * as Commands from '../lanes/commands'
import type * as Calls from '../lanes/calls'
import type * as Administration from './run-administration'

/** Start-up steps in the order run takes them; teardown order is pinned in run.runtime.test.ts. */
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
    return { deliver: () => {}, isConnected: () => false, stop: async () => {} }
  },
}))
vi.mock('../lanes/store', async (original) => {
  const module = await original<typeof Store>()
  return {
    ...module,
    openStore: async (...args: Parameters<typeof module.openStore>) => {
      hooks.order.push('store')
      const store = await module.openStore(...args)
      const sync = store.syncRepositories.bind(store)
      store.syncRepositories = (...rest) => {
        hooks.order.push('repositories')
        return sync(...rest)
      }
      return store
    },
  }
})
vi.mock('../features/attachments', async (original) => {
  const module = await original<typeof Attachments>()
  return {
    ...module,
    createAttachments: (...args: Parameters<typeof module.createAttachments>) => {
      hooks.order.push('attachments')
      return module.createAttachments(...args)
    },
  }
})
vi.mock('../session/runtime', async (original) => {
  const module = await original<typeof Runtime>()
  return {
    ...module,
    createHostRuntime: (...args: Parameters<typeof module.createHostRuntime>) => {
      hooks.order.push('runtime')
      return module.createHostRuntime(...args)
    },
  }
})
vi.mock('../lanes/live-host', async (original) => {
  const module = await original<typeof LiveHost>()
  return {
    ...module,
    createHostLiveLanes: (...args: Parameters<typeof module.createHostLiveLanes>) => {
      hooks.order.push('live')
      return module.createHostLiveLanes(...args)
    },
  }
})
vi.mock('../routines/service', async (original) => {
  const module = await original<typeof Routines>()
  return {
    ...module,
    createHostRoutines: (...args: Parameters<typeof module.createHostRoutines>) => {
      hooks.order.push('routines')
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
vi.mock('../lanes/naming', async (original) => {
  const module = await original<typeof Naming>()
  return {
    ...module,
    createLaneNamer: (...args: Parameters<typeof module.createLaneNamer>) => {
      hooks.order.push('naming')
      return module.createLaneNamer(...args)
    },
  }
})
vi.mock('../lanes/commands', async (original) => {
  const module = await original<typeof Commands>()
  return {
    ...module,
    createLaneCommands: (...args: Parameters<typeof module.createLaneCommands>) => {
      hooks.order.push('commands')
      return module.createLaneCommands(...args)
    },
  }
})
vi.mock('../lanes/calls', async (original) => {
  const module = await original<typeof Calls>()
  return {
    ...module,
    createLaneCalls: (...args: Parameters<typeof module.createLaneCalls>) => {
      hooks.order.push('calls')
      return module.createLaneCalls(...args)
    },
  }
})
vi.mock('./run-administration', async (original) => {
  const module = await original<typeof Administration>()
  return {
    ...module,
    createRunTerminals: (...args: Parameters<typeof module.createRunTerminals>) => {
      hooks.order.push('terminals')
      return module.createRunTerminals(...args)
    },
    createRunAdministration: (...args: Parameters<typeof module.createRunAdministration>) => {
      hooks.order.push('administration')
      return module.createRunAdministration(...args)
    },
    startRunWebPush: async (...args: Parameters<typeof module.startRunWebPush>) => {
      hooks.order.push('webPush')
      return module.startRunWebPush(...args)
    },
  }
})
afterEach(() => {
  hooks.order = []
  hooks.machine = null
  vi.unstubAllEnvs()
})

/** Runs an enrolled Host until its first running heartbeat, recording every start-up step. */
async function startUp(usable: boolean) {
  const control = await controlMachine()
  const pi = fakeMachine({ rpc: true })
  try {
    await control.enrollOld()
    vi.stubEnv('PATH', process.env.PATH)
    vi.stubEnv('PI_CODING_AGENT_DIR', pi.agentDir)
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
    if (usable)
      hooks.machine = {
        pi: { binaryPath: process.execPath, prefixArgs: [pi.cli] },
        env: buildPiEnvironment({
          hostEnv: pi.hostEnv,
          nodePath: process.execPath,
          platform: process.platform,
        }).env,
        roots: [pi.repository],
        resourceRoot: EXTENSIONS_ROOT,
        contextBudget: '',
      }
    const result = await runHost({
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
      loadConfig: async (...args) => {
        hooks.order.push('config')
        return loadHostConfig(...args)
      },
      reconcile: async (...args) => {
        hooks.order.push('reconcile')
        return reconcile(...args)
      },
      fetch: async (_url, init) => {
        const body: unknown = JSON.parse(String(init?.body))
        const state = body && typeof body === 'object' && 'state' in body ? body.state : undefined
        hooks.order.push(`heartbeat:${String(state)}`)
        return Response.json({ accepted: true, nextInSec: 30 })
      },
      wait: async () => {
        control.abort.abort()
      },
    })
    return { result, output: control.output.join('\n') }
  } finally {
    await control.cleanup()
    pi.cleanup()
  }
}

describe('run start-up order', () => {
  it('builds state, then the machine, then the API, all before the first heartbeat', async () => {
    const { result, output } = await startUp(true)
    expect(result, output).toBe(0)
    expect(hooks.order).toEqual([
      'config',
      'store',
      'repositories',
      'reconcile',
      'attachments',
      'inspect',
      'runtime',
      'live',
      'routines',
      'naming',
      'terminals',
      'administration',
      'commands',
      'webPush',
      'calls',
      'routines.start',
      'api',
      'heartbeat:running',
      'heartbeat:stopping',
    ])
  })
  it('still starts the API before the first heartbeat when the machine is unusable', async () => {
    const { result, output } = await startUp(false)
    expect(result, output).toBe(0)
    expect(hooks.order).toEqual([
      'config',
      'store',
      'repositories',
      'reconcile',
      'attachments',
      'inspect',
      'api',
      'heartbeat:running',
      'heartbeat:stopping',
    ])
  })
})
