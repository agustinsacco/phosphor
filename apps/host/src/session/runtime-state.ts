import { hostname, type as osType } from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'
import { piAgentDir } from '@phosphor/session-runtime/pi/pi-paths'
import type { HostClaudeAccounts } from '../providers/accounts'
import { createRuntimeAccounts } from './runtime-accounts'
import type { MachineContext } from '@phosphor/shared/machine-prompt'
import type { SessionPush } from '@phosphor/shared/models'
import { createContextBudgetRuntime } from '@phosphor/session-runtime/pi/context-budget'
import { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import { createSessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import { SessionRegistry } from '@phosphor/session-runtime/pi/session-registry'
import type { SessionServiceRuntime } from '@phosphor/session-runtime/pi/session-service'
import type { ConfigError } from '../config/schema'
import type { HostLog } from '../machine/log'
import {
  DRAIN,
  createLifecycle,
  trackProcessGroups,
  type DrainTimings,
  type Lifecycle,
  type ProcessGroups,
} from './lifecycle'

/** What a validated Host knows about its machine. 05-D assembles it from doctor's checks. */
export interface HostMachine {
  /** pi as doctor resolved it: node and pi's cli, or pi alone. Never a stub. */
  pi: { binaryPath: string; prefixArgs: string[] }
  /** All of pi's environment, PATH included: what buildPiEnvironment built. */
  env: Record<string, string>
  /** Real paths of the configured repositories. */
  roots: readonly string[]
  /** The folder holding pi-ext/. */
  resourceRoot: string
  /** In Desktop's grammar; '' is the 200k default. */
  contextBudget: string
  machineContext?: Extract<MachineContext, { kind: 'host' }>
  log: HostLog
}

/** Where a session's pushes go. 07 replaces it with the projection. */
export type Delivery = (push: SessionPush) => void

/** A request the parser refused, with every problem at its JSON pointer. */
export class RequestError extends Error {
  constructor(readonly errors: ConfigError[]) {
    super(`invalid request: ${errors.map((e) => `${e.pointer || '/'} ${e.message}`).join('; ')}`)
    this.name = 'RequestError'
  }
}

export interface RuntimeOptions {
  claudeAccounts?: HostClaudeAccounts
  trashTranscript?: (path: string) => Promise<void>
  life?: Lifecycle
  timings?: Partial<DrainTimings>
  dialogs?: 'cancel' | 'forward'
  routines?: SessionServiceRuntime<Delivery>['routines']
}

/** One process-local ownership domain, shared by every start, command and deletion. */
export interface RuntimeState {
  machine: HostMachine
  agentDir: string
  authorization: AsyncLocalStorage<() => boolean>
  accounts: ReturnType<typeof createRuntimeAccounts>
  options: RuntimeOptions
  roots: string[]
  machineContext: Extract<MachineContext, { kind: 'host' }>
  life: Lifecycle
  timings: DrainTimings
  registry: SessionRegistry
  paths: ReturnType<typeof createSessionPathRuntime>
  budget: ReturnType<typeof createContextBudgetRuntime>
  groups: ProcessGroups
  started: WeakSet<Delivery>
  /** Extension prompts in flight, including their final file-identity read. */
  moving: number
  /** Live sessions whose last file-identity read failed. Disposal clears their risk. */
  lost: Set<string>
}

export function createRuntimeState(machine: HostMachine, options: RuntimeOptions): RuntimeState {
  const { log } = machine
  const roots = [...machine.roots]
  const machineContext: RuntimeState['machineContext'] = {
    kind: 'host',
    label: machine.machineContext?.label ?? hostname(),
    os: machine.machineContext?.os ?? osType(),
    repositories: machine.machineContext?.repositories ?? [],
  }
  const timings: DrainTimings = { ...DRAIN, ...options.timings }
  const life = options.life ?? createLifecycle(log.write)
  const path = machine.env.PATH
  if (!path) throw new Error("pi's environment has no PATH")
  // gitInfo runs git from this process's PATH: make it pi's, so both find the same git.
  process.env.PATH = path
  const authorization = new AsyncLocalStorage<() => boolean>()
  const registry = new SessionRegistry({
    createClient: (spawn) =>
      new PiRpcClient(
        { ...spawn, inheritEnv: false },
        { log: log.write, isClosing: life.isDraining },
      ),
    assertCanStart: () => {
      life.assertReady()
      if (authorization.getStore()?.() === false) throw new Error('Lane control changed.')
    },
  })
  return {
    machine,
    agentDir: piAgentDir(machine.env),
    authorization,
    accounts: createRuntimeAccounts(registry, options.claudeAccounts, log),
    options,
    roots,
    machineContext,
    timings,
    life,
    registry,
    groups: trackProcessGroups(registry),
    paths: createSessionPathRuntime(),
    budget: createContextBudgetRuntime(log.write),
    started: new WeakSet<Delivery>(),
    moving: 0,
    lost: new Set<string>(),
  }
}
