import { basename } from 'node:path'
import type { CreateSessionOptions, LiveSessionInfo, SessionPush } from '@shared/models'
import { RATE_LIMIT_STATUS_KEY, accountExhaustedUntil } from '@shared/claude-limits'
import type { RuntimeLog } from '../file-log'
import { syncContextBudget } from './context-budget'
import { healMissingSessionCwd } from './session-cwd'
import { bindSessionEvents, type SessionEventRuntime } from './session-events'
import type { prepareSessionLaunch } from './session-launch'
import {
  prepareSessionPolicy,
  type SessionExecution,
  type SessionPolicyRuntime,
} from './session-policy'
import type { SessionRegistry } from './session-registry'
import type { LaneReload } from './lane-reload'

export interface SessionStartupRuntime {
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

/** Low-level spawn; resumed files must be admitted through the owner's path lock. */
export function createSessionStartup(runtime: SessionStartupRuntime) {
  return async function spawnSession(
    rawOptions: CreateSessionOptions,
    sink: SessionSink,
    execution: SessionExecution = {},
  ): Promise<LiveSessionInfo> {
    execution.signal?.throwIfAborted()
    const options = {
      ...rawOptions,
      workspacePath: runtime.resolveWorkspace(rawOptions.workspacePath) ?? rawOptions.workspacePath,
    }
    if (options.sessionPath) {
      const healed = await healMissingSessionCwd(options.sessionPath, options.workspacePath).catch(
        () => false,
      )
      if (healed) runtime.log('pi', 'repointed session cwd', { path: options.sessionPath })
    }
    const launch = await runtime.launch()
    const { spawnOptions, accountId } = await prepareSessionPolicy(
      options,
      execution,
      launch,
      runtime.policy,
    )
    execution.signal?.throwIfAborted()
    // Read before the spawn: a change landing while pi starts must still count as new.
    const laneConfig =
      runtime.laneReload && !launch.stub
        ? await runtime.laneReload.capture(options.workspacePath)
        : null
    const session = runtime.registry.create(options.workspacePath, spawnOptions)
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
      bindSessionEvents(session, {
        emit: sink(session.sessionId),
        log: runtime.log,
        budget: { ...runtime.budget, paused: () => runtime.budget.paused(session.sessionId) },
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
      if (!launch.stub) await syncContextBudget(session.client, runtime.budget.read())
      execution.signal?.throwIfAborted()
      if (!session.client.alive) throw new Error('Session stopped during startup.')
      if (accountId) runtime.accounts.remember(session.sessionId, accountId)
      runtime.laneReload?.track(session.sessionId, laneConfig, session.client)
      // Automation must not replace the user's launch-resume folder.
      if (!execution.unattended)
        runtime.recordWorkspace(options.workspacePath, basename(options.workspacePath))
      return {
        sessionId: session.sessionId,
        workspacePath: session.workspacePath,
        pid: session.client.pid,
      }
    } catch (error) {
      await runtime.registry.dispose(session.sessionId)
      runtime.accounts.forget(session.sessionId)
      execution.signal?.throwIfAborted()
      throw error
    } finally {
      execution.signal?.removeEventListener('abort', stopOnAbort)
    }
  }
}
