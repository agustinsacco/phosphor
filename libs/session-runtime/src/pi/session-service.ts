import { access } from 'node:fs/promises'
import type { CreateSessionOptions, LiveSessionInfo } from '@shared/models'
import type { ExtensionUIResponse, RpcCommand } from '@shared/rpc'
import { syncContextBudget, type createContextBudgetRuntime } from './context-budget'
import { assertClaudeContextProvider } from './provider-detect'
import { sessionPathKey, type SessionPathRuntime } from './session-path-lock'
import type { SessionExecution, SessionPolicyRuntime } from './session-policy'
import type { LiveSession, SessionRegistry } from './session-registry'
import type { LaneReload } from './lane-reload'
import { controlMcpInLane } from './mcp-lane'

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

// Admission holds the same registry, lock domain and routine owner for the facade's lifetime.
type SessionAdmission = Pick<SessionServiceRuntime<unknown>, 'registry' | 'paths' | 'routines'> & {
  mcpBusy: Set<string>
  mutating: Map<string, number>
}

async function create<Delivery>(
  runtime: SessionServiceRuntime<Delivery>,
  { registry, paths, routines }: SessionAdmission,
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
    const matches = registry.list().filter((s) => s.diskPath && sessionPathKey(s.diskPath) === path)
    const live = matches.find((s) => registry.get(s.sessionId)?.client.alive)
    if (live) return live
    for (const session of matches) await registry.dispose(session.sessionId)
    // pi creates a new file for a missing --session. Never resurrect a deleted lane.
    await access(path)
    signal.throwIfAborted()
    return runtime.spawn({ ...options, sessionPath: path }, delivery, { ...execution, signal })
  })
}

function session({ registry }: SessionAdmission, id: string): LiveSession {
  const found = registry.get(id)
  if (!found) throw new Error(`Unknown session: ${id}`)
  return found
}

function assertManualCommand(
  { routines, mcpBusy }: SessionAdmission,
  id: string,
  command: RpcCommand,
) {
  if (mcpBusy.has(id) && !command.type.startsWith('get_') && command.type !== 'abort')
    throw new Error(
      'This lane is reconnecting a connector. Wait for it to finish before sending new work.',
    )
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

async function preflightCommand<Delivery>(
  runtime: SessionServiceRuntime<Delivery>,
  live: LiveSession,
  id: string,
  command: RpcCommand,
): Promise<void> {
  if (runtime.isStub()) return
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

async function dispatchCommand<Delivery>(
  runtime: SessionServiceRuntime<Delivery>,
  admission: SessionAdmission,
  live: LiveSession,
  id: string,
  command: RpcCommand,
) {
  // Ownership may change while a command waits behind compaction.
  assertManualCommand(admission, id, command)
  await preflightCommand(runtime, live, id, command)
  const result = await live.client.request(command)
  if (!runtime.isStub() && command.type === 'set_auto_compaction' && result.success) {
    await syncContextBudget(live.client, runtime.readBudget())
  }
  return result
}

async function command<Delivery>(
  runtime: SessionServiceRuntime<Delivery>,
  admission: SessionAdmission,
  id: string,
  command: RpcCommand,
) {
  const live = session(admission, id)
  if (command.type === 'get_messages') admission.routines.observe(id)
  assertManualCommand(admission, id, command)
  const mutating = !command.type.startsWith('get_')
  if (mutating) admission.mutating.set(id, (admission.mutating.get(id) ?? 0) + 1)
  try {
    return await runtime.withBudgetCompaction(id, command.type, () =>
      dispatchCommand(runtime, admission, live, id, command),
    )
  } finally {
    if (mutating) {
      const remaining = (admission.mutating.get(id) ?? 1) - 1
      if (remaining) admission.mutating.set(id, remaining)
      else admission.mutating.delete(id)
    }
  }
}

async function mcpControl(
  runtime: Pick<SessionServiceRuntime<unknown>, 'withBudgetCompaction'>,
  admission: SessionAdmission,
  id: string,
  name: string,
  operation: 'inspect' | 'reconnect',
) {
  const live = session(admission, id)
  if (operation !== 'inspect' && operation !== 'reconnect')
    throw new Error('Invalid MCP operation.')
  if (admission.routines.owns(id))
    throw new Error('Connector controls are unavailable in a running routine.')
  if (admission.mcpBusy.has(id)) throw new Error('This lane is already reconnecting a connector.')
  if (operation === 'reconnect' && admission.mutating.has(id))
    throw new Error('This lane is busy. Retry after its current command finishes.')
  if (operation === 'reconnect') admission.mcpBusy.add(id)
  try {
    return await runtime.withBudgetCompaction(
      id,
      operation === 'reconnect' ? 'prompt' : 'get_state',
      () => {
        if (admission.routines.owns(id))
          throw new Error('Connector controls are unavailable in a running routine.')
        return controlMcpInLane(live.client, name, operation)
      },
    )
  } finally {
    if (operation === 'reconnect') admission.mcpBusy.delete(id)
  }
}

function respond(admission: SessionAdmission, id: string, response: ExtensionUIResponse): void {
  session(admission, id).client.respondToExtensionUI(response)
}

async function dispose<Delivery>(
  runtime: SessionServiceRuntime<Delivery>,
  { registry, routines }: SessionAdmission,
  id: string,
): Promise<void> {
  if (routines.owns(id)) await routines.cancel(id)
  runtime.forgetAccount(id)
  await registry.dispose(id)
}

/** Process-local admission, not a network authorization boundary. */
export function createSessionService<Delivery>(runtime: SessionServiceRuntime<Delivery>) {
  const { registry, paths, routines } = runtime
  const admission: SessionAdmission = {
    registry,
    paths,
    routines,
    mcpBusy: new Set(),
    mutating: new Map(),
  }
  return {
    create: (options: CreateSessionOptions, delivery?: Delivery, execution?: SessionExecution) =>
      create(runtime, admission, options, delivery, execution),
    command: (id: string, rpcCommand: RpcCommand) => command(runtime, admission, id, rpcCommand),
    respond: (id: string, response: ExtensionUIResponse) => respond(admission, id, response),
    mcpControl: (id: string, name: string, operation: 'inspect' | 'reconnect') =>
      mcpControl(runtime, admission, id, name, operation),
    dispose: (id: string) => dispose(runtime, admission, id),
    list: () => registry.list(),
  }
}
