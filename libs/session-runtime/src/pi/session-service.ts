import { access } from 'node:fs/promises'
import type { CreateSessionOptions, LiveSessionInfo } from '@shared/models'
import type { ExtensionUIResponse, RpcCommand } from '@shared/rpc'
import { syncContextBudget, type createContextBudgetRuntime } from './context-budget'
import { assertClaudeContextProvider } from './provider-detect'
import { sessionPathKey, type SessionPathRuntime } from './session-path-lock'
import type { SessionExecution, SessionPolicyRuntime } from './session-policy'
import type { SessionRegistry } from './session-registry'
import type { LaneReload } from './lane-reload'

export interface SessionServiceRuntime<Delivery> {
  registry: Pick<SessionRegistry, 'get' | 'list' | 'dispose'>
  paths: SessionPathRuntime
  spawn: (
    options: CreateSessionOptions,
    delivery?: Delivery,
    execution?: SessionExecution,
  ) => Promise<LiveSessionInfo>
  isStub: () => boolean
  packages: SessionPolicyRuntime['packages']
  readBudget: () => string
  withBudgetCompaction: ReturnType<typeof createContextBudgetRuntime>['withBudgetCompaction']
  forgetAccount: (id: string) => void
  /** Brings changed lane config (MCP servers) into a running lane before its next turn. */
  laneReload?: Pick<LaneReload, 'beforePrompt'>
  routines: {
    owns: (id: string) => boolean
    sessionForPath: (path: string) => string | undefined
    observe: (id: string) => void
    cancel: (id: string) => Promise<void>
  }
}

/** Process-local admission, not a network authorization boundary. */
export function createSessionService<Delivery>(runtime: SessionServiceRuntime<Delivery>) {
  const { registry, paths, routines } = runtime
  async function create(
    options: CreateSessionOptions,
    delivery?: Delivery,
    execution: SessionExecution = {},
  ): Promise<LiveSessionInfo> {
    execution.signal?.throwIfAborted()
    const ownedId = options.sessionPath ? routines.sessionForPath(options.sessionPath) : undefined
    const owned = ownedId ? registry.get(ownedId) : undefined
    if (owned)
      return {
        sessionId: owned.sessionId,
        workspacePath: owned.workspacePath,
        pid: owned.client.pid,
      }
    if (!options.sessionPath) return runtime.spawn(options, delivery, execution)
    const path = sessionPathKey(options.sessionPath)
    return paths.openSessionPath(path, async (openingSignal) => {
      const signal = execution.signal
        ? AbortSignal.any([execution.signal, openingSignal])
        : openingSignal
      signal.throwIfAborted()
      const matches = registry
        .list()
        .filter((s) => s.diskPath && sessionPathKey(s.diskPath) === path)
      const live = matches.find((s) => registry.get(s.sessionId)?.client.alive)
      if (live) return live
      for (const session of matches) await registry.dispose(session.sessionId)
      // pi creates a new file for a missing --session. Never resurrect a deleted lane.
      await access(path)
      signal.throwIfAborted()
      return runtime.spawn({ ...options, sessionPath: path }, delivery, { ...execution, signal })
    })
  }

  function session(id: string) {
    const found = registry.get(id)
    if (!found) throw new Error(`Unknown session: ${id}`)
    return found
  }
  function assertManualCommand(id: string, command: RpcCommand) {
    if (
      routines.owns(id) &&
      ![
        'get_state',
        'get_messages',
        'get_session_stats',
        'get_available_models',
        'get_commands',
      ].includes(command.type)
    ) {
      throw new Error(
        'This lane is owned by a running routine. Cancel it from Routines before continuing manually.',
      )
    }
  }
  async function command(id: string, command: RpcCommand) {
    const live = session(id)
    if (command.type === 'get_messages') routines.observe(id)
    assertManualCommand(id, command)
    return runtime.withBudgetCompaction(id, command.type, async () => {
      // Ownership may change while a command waits behind compaction.
      assertManualCommand(id, command)
      if (!runtime.isStub()) {
        if (command.type === 'set_model' && command.provider === 'pi-claude-cli') {
          assertClaudeContextProvider(await runtime.packages(live.workspacePath))
        }
        if (command.type === 'prompt') {
          const state = await live.client.request({ type: 'get_state' })
          if (!state.success || !state.data) throw new Error('Cannot verify the active pi model.')
          // Only a prompt that starts a turn: one sent mid-run joins that run,
          // and a host control (`/phosphor-…`) starts none. Before the budget
          // sync, because a reload drops the lane's capped context window.
          if (
            runtime.laneReload &&
            !state.data.isStreaming &&
            !state.data.isCompacting &&
            !command.message.startsWith('/phosphor-')
          )
            await runtime.laneReload.beforePrompt(id, live.client, live.workspacePath)
          if (state.data.model?.provider === 'pi-claude-cli')
            assertClaudeContextProvider(await runtime.packages(live.workspacePath))
          await syncContextBudget(live.client, runtime.readBudget())
        }
      }
      const result = await live.client.request(command)
      if (!runtime.isStub() && command.type === 'set_auto_compaction' && result.success) {
        await syncContextBudget(live.client, runtime.readBudget())
      }
      return result
    })
  }
  function respond(id: string, response: ExtensionUIResponse): void {
    session(id).client.respondToExtensionUI(response)
  }
  async function dispose(id: string): Promise<void> {
    if (routines.owns(id)) await routines.cancel(id)
    runtime.forgetAccount(id)
    await registry.dispose(id)
  }
  return { create, command, respond, dispose, list: () => registry.list() }
}
