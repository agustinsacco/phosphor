import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import { SessionRegistry } from '../session-registry'
import type { PiRpcClient, PiSpawnOptions } from '../rpc-client'
import { createContextBudgetRuntime } from '../context-budget'
import { createSessionStartup, type SessionStartupRuntime } from '../session-startup'
import type { RpcCommand } from '@shared/rpc'

export function sessionFixture() {
  const clients: ReturnType<typeof fakeClient>[] = []
  function fakeClient(options: PiSpawnOptions) {
    const client = Object.assign(new EventEmitter(), {
      alive: false,
      pid: 123,
      sessionFile: options.sessionPath,
      spawn: vi.fn(() => {
        client.alive = true
      }),
      request: vi.fn(async (_command: RpcCommand) => ({
        success: true,
        data: { autoCompactionEnabled: true, model: { provider: 'native' } },
      })),
      dispose: vi.fn(async () => {
        client.alive = false
        client.emit('exit', { code: 0, signal: null, expected: true })
      }),
      respondToExtensionUI: vi.fn(),
      killNow: vi.fn(),
    })
    return client
  }
  const log = vi.fn()
  const registry = new SessionRegistry({
    createClient: (options) => {
      const client = fakeClient(options)
      clients.push(client)
      return client as unknown as PiRpcClient
    },
    assertCanStart: vi.fn(),
  })
  const budget = createContextBudgetRuntime(log)
  const runtime: SessionStartupRuntime = {
    registry,
    resolveWorkspace: vi.fn((path) => path),
    launch: vi.fn(async () => ({ stub: false, env: {}, extensions: [] })),
    policy: {
      machineContext: () => ({ kind: 'desktop', signedIn: false }),
      git: vi.fn(async () => ({ isRepo: false })),
      preferences: () => ({
        agentDirectives: {
          machineAwareness: true,
          worktreeGuard: false,
          laneCharter: false,
          subagentPolicy: false,
          custom: '',
        },
        agentDirectivesByProject: {},
      }),
      defaultProvider: vi.fn(async () => 'native'),
      packages: vi.fn(async () => []),
      account: vi.fn(async () => null),
      compressionEnvironment: () => ({}),
      resetCompaction: vi.fn(async () => {}),
    },
    log,
    budget: {
      watch: budget.watchContextBudget,
      read: vi.fn(() => '200k'),
      paused: vi.fn(() => false),
    },
    accounts: { remember: vi.fn(), forget: vi.fn(), hold: vi.fn(async () => {}) },
    recordWorkspace: vi.fn(),
  }
  const emit = vi.fn()
  return {
    runtime,
    registry,
    clients,
    budget,
    emit,
    sink: () => emit,
    spawn: createSessionStartup(runtime),
  }
}
