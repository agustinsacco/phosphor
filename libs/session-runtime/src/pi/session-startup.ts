import { attachSessionMemory } from './session-memory'
import type { SessionUserInput, SessionInputReceipt } from './session-input'
export type { SessionUserInput, SessionInputReceipt } from './session-input'
import { basename } from 'node:path'
import type { CreateSessionOptions, LiveSessionInfo, SessionPush } from '@shared/models'
import { RATE_LIMIT_STATUS_KEY, accountExhaustedUntil } from '@shared/claude-limits'
import type { RuntimeLog } from '../file-log'
import { syncContextBudget } from './context-budget'
import { verifyStartupAccount } from './session-account'
import { healMissingSessionCwd } from './session-cwd'
import { bindSessionEvents, type SessionEventRuntime } from './session-events'
import type { prepareSessionLaunch } from './session-launch'
import {
  prepareSessionPolicy,
  type SessionExecution,
  type SessionPolicyRuntime,
} from './session-policy'
import type { LiveSession, SessionRegistry } from './session-registry'
import type { LaneReload } from './lane-reload'
import type { PiSpawnOptions } from './rpc-client'
import { verifyBrainModel } from './brain-execution-profile'

/** Trusted, opt-in augmentation; its owner revokes successful capabilities on registry disposal. */
export interface SessionMemoryAugmentation {
  env?: Record<string, string>
  extensions?: string[]
  onCreated: (session: LiveSession) => void | Promise<void>
  beforeInput?: (command: SessionUserInput) => Promise<SessionInputReceipt | undefined>
  invalidateInput?: () => void
  /** Must be idempotent: startup failure and registry disposal may both revoke it. */
  dispose: () => void | Promise<void>
}

export interface SessionStartupRuntime {
  memory?: {
    prepare: (
      options: Readonly<CreateSessionOptions>,
    ) => Promise<SessionMemoryAugmentation | undefined>
  }
  registry: Pick<SessionRegistry, 'create' | 'dispose'>
  resolveWorkspace: (path: string) => string | null
  launch: () => ReturnType<typeof prepareSessionLaunch>
  policy: SessionPolicyRuntime
  log: RuntimeLog
  budget: Omit<SessionEventRuntime['budget'], 'paused'> & { paused: (id: string) => boolean }
  accounts: {
    remember: (sessionId: string, accountId: string) => void
    forget: (sessionId: string) => void
    hold: (accountId: string, until: number) => Promise<void>
  }
  recordWorkspace: (path: string, name: string) => void
  laneReload?: Pick<LaneReload, 'capture' | 'track'>
}

export type SessionSink = (sessionId: string) => (payload: SessionPush) => void

function bindStartupEvents(
  runtime: SessionStartupRuntime,
  session: LiveSession,
  sink: SessionSink,
  accountId: string | undefined,
): void {
  bindSessionEvents(session, {
    emit: sink(session.sessionId),
    log: runtime.log,
    budget: {
      ...runtime.budget,
      ...(session.owner ? { watch: () => {} } : {}),
      paused: () => runtime.budget.paused(session.sessionId),
    },
    onExtensionUI: (request) => {
      if (
        accountId &&
        request.method === 'setStatus' &&
        request.statusKey === RATE_LIMIT_STATUS_KEY
      ) {
        const until = accountExhaustedUntil(request.statusText)
        if (until !== null) void runtime.accounts.hold(accountId, until).catch(() => undefined)
      }
    },
  })
}

function completeStartup(
  runtime: SessionStartupRuntime,
  session: LiveSession,
  options: CreateSessionOptions,
  execution: SessionExecution,
  accountId: string | undefined,
  laneConfig: string | null,
): LiveSessionInfo {
  execution.signal?.throwIfAborted()
  if (!session.client.alive) throw new Error('Session stopped during startup.')
  if (accountId) runtime.accounts.remember(session.sessionId, accountId)
  if (!(execution.brain || execution.learning))
    runtime.laneReload?.track(session.sessionId, laneConfig, session.client)
  // Automation must not replace the user's launch-resume folder.
  if (!execution.unattended && !(execution.brain || execution.learning))
    runtime.recordWorkspace(options.workspacePath, basename(options.workspacePath))
  session.startupComplete = true
  return {
    sessionId: session.sessionId,
    workspacePath: session.workspacePath,
    pid: session.client.pid,
  }
}

async function prepareStartup(
  runtime: SessionStartupRuntime,
  rawOptions: CreateSessionOptions,
  execution: SessionExecution,
) {
  const options =
    execution.brain || execution.learning
      ? rawOptions
      : {
          ...rawOptions,
          workspacePath:
            runtime.resolveWorkspace(rawOptions.workspacePath) ?? rawOptions.workspacePath,
        }
  if (options.sessionPath && !(execution.brain || execution.learning)) {
    const healed = await healMissingSessionCwd(options.sessionPath, options.workspacePath).catch(
      () => false,
    )
    if (healed) runtime.log('pi', 'repointed session cwd', { path: options.sessionPath })
  }
  const launch =
    execution.brain || execution.learning
      ? { stub: false, env: {}, extensions: [] }
      : await runtime.launch()
  const { spawnOptions, accountId } = await prepareSessionPolicy(
    options,
    execution,
    launch,
    runtime.policy,
  )
  execution.signal?.throwIfAborted()
  // Read before the spawn: a change landing while pi starts must still count as new.
  const laneConfig =
    runtime.laneReload && !launch.stub && !(execution.brain || execution.learning)
      ? await runtime.laneReload.capture(options.workspacePath)
      : null
  execution.signal?.throwIfAborted()
  const memory =
    !launch.stub && !(execution.brain || execution.learning) && !execution.unattended
      ? await runtime.memory?.prepare(options)
      : undefined
  if (memory) {
    if (memory.env) spawnOptions.env = { ...spawnOptions.env, ...memory.env }
    if (memory.extensions)
      spawnOptions.extensions = [...(spawnOptions.extensions ?? []), ...memory.extensions]
  }
  return { options, launch, spawnOptions, accountId, laneConfig, memory }
}

async function allocateSession(
  runtime: SessionStartupRuntime,
  options: CreateSessionOptions,
  spawnOptions: Omit<PiSpawnOptions, 'cwd'>,
  execution: SessionExecution,
  memory: SessionMemoryAugmentation | undefined,
): Promise<LiveSession> {
  try {
    execution.signal?.throwIfAborted()
    return runtime.registry.create(
      options.workspacePath,
      spawnOptions,
      (execution.brain ?? execution.learning)?.owner,
    )
  } catch (error) {
    await memory?.dispose()
    throw error
  }
}

async function spawnSession(
  runtime: SessionStartupRuntime,
  rawOptions: CreateSessionOptions,
  sink: SessionSink,
  execution: SessionExecution = {},
): Promise<LiveSessionInfo> {
  execution.signal?.throwIfAborted()
  const { options, launch, spawnOptions, accountId, laneConfig, memory } = await prepareStartup(
    runtime,
    rawOptions,
    execution,
  )
  const session = await allocateSession(runtime, options, spawnOptions, execution, memory)
  const stopOnAbort = (): void => {
    void runtime.registry.dispose(session.sessionId).catch((error: unknown) => {
      runtime.log('pi', 'startup cancellation failed', {
        sessionId: session.sessionId,
        error: String(error),
      })
    })
  }
  execution.signal?.addEventListener('abort', stopOnAbort, { once: true })
  if (execution.signal?.aborted) stopOnAbort()
  try {
    execution.signal?.throwIfAborted()
    if (memory) await attachSessionMemory(session, memory, runtime.log)
    execution.signal?.throwIfAborted()
    bindStartupEvents(runtime, session, sink, accountId)
    if (execution.brain || execution.learning)
      await verifyBrainModel(session.client, (execution.brain ?? execution.learning)!)
    else if (!launch.stub) {
      await verifyStartupAccount(session.client, runtime.policy.strictAccountSelection, accountId)
      await syncContextBudget(session.client, runtime.budget.read())
    }
    return completeStartup(runtime, session, options, execution, accountId, laneConfig)
  } catch (error) {
    try {
      await runtime.registry.dispose(session.sessionId)
      runtime.accounts.forget(session.sessionId)
    } finally {
      await memory?.dispose()
    }
    execution.signal?.throwIfAborted()
    throw error
  } finally {
    execution.signal?.removeEventListener('abort', stopOnAbort)
  }
}

/** Low-level spawn; resumed files must be admitted through the owner's path lock. */
export function createSessionStartup(runtime: SessionStartupRuntime) {
  return spawnSession.bind(null, runtime)
}
